
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Mic, MicOff, Loader2, AlertTriangle, LanguagesIcon, ScreenShare, AudioLines } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { supportedLanguages } from "@/lib/languages";
import { useToast } from "@/hooks/use-toast";
import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Separator } from "@/components/ui/separator";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";


type StreamingState = "idle" | "recognizing" | "error" | "stopping";
type AudioInputMode = "microphone" | "system";

const MEDIA_RECORDER_TIMESLICE_MS = 1000;

export default function LinguaVoxPage() {
  const ws = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const systemAudioStreamRef = useRef<MediaStream | null>(null);
  const { toast } = useToast();

  const [sourceLanguage, setSourceLanguage] = useState<string>("pt");
  const [targetLanguage, setTargetLanguage] = useState<string>("en");

  const [streamingState, setStreamingState] = useState<StreamingState>("idle");
  const streamingStateRef = useRef<StreamingState>(streamingState);

  useEffect(() => {
    streamingStateRef.current = streamingState;
  }, [streamingState]);


  const [audioInputMode, setAudioInputMode] = useState<AudioInputMode>("microphone");
  const audioInputModeRef = useRef(audioInputMode);
  useEffect(() => {
    audioInputModeRef.current = audioInputMode;
  }, [audioInputMode]);

  const [transcribedText, setTranscribedText] = useState<string>("");
  const [translatedText, setTranslatedText] = useState<string>("");
  const [isProcessingServer, setIsProcessingServer] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [supportedMimeType, setSupportedMimeType] = useState<string | null>(null);


  const getWebSocketUrl = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = process.env.NEXT_PUBLIC_WEBSOCKET_PORT || '3001';
    return `${protocol}//${window.location.hostname}:${wsPort}`;
  };

  const connectWebSocket = useCallback(() => {
    return new Promise<void>((resolve, reject) => {
        const WS_URL = getWebSocketUrl();
        console.log("[Client] Attempting to connect to WebSocket at:", WS_URL);

        // Clean up any existing WebSocket instance thoroughly before creating a new one.
        if (ws.current) {
            console.warn("[Client] Previous WebSocket instance found. Cleaning it up before reconnecting.", {readyState: ws.current.readyState});
            ws.current.onopen = null;
            ws.current.onmessage = null;
            ws.current.onerror = null;
            ws.current.onclose = null; // Ensure onclose is nulled to prevent its logic from firing during cleanup
            if (ws.current.readyState !== WebSocket.CLOSED && ws.current.readyState !== WebSocket.CLOSING) {
                ws.current.close(1000, "Reconnecting: Old instance cleanup");
            }
            ws.current = null;
        }

        const newWs = new WebSocket(WS_URL);
        // Assign to ws.current immediately for consistent checking in handlers.
        ws.current = newWs;

        newWs.onopen = () => {
            if (ws.current !== newWs) {
                console.log("[Client] onopen: Stale WebSocket instance detected. Closing this stale connection and ignoring open event.");
                newWs.close(1000, "Stale onopen callback");
                // Do not reject here, as the *current* ws.current might be a different, valid connection
                // or another connection attempt might be in progress.
                return;
            }
            console.log("[Client] WebSocket connected (client-side via newWs.onopen)");
            setError(null); // Clear any previous connection errors
            resolve();
        };

        newWs.onmessage = (event) => {
            if (ws.current !== newWs) {
                console.log("[Client] onmessage: Stale WebSocket instance. Ignoring message.");
                return;
            }
            try {
                const serverMessage = JSON.parse(event.data as string);
                console.log("[Client] Message received from server:", serverMessage);

                if (serverMessage.type === "translated_text_for_listener") {
                    setTranslatedText(prev => prev ? prev.trim() + " " + serverMessage.text.trim() : serverMessage.text.trim());
                } else if (serverMessage.error) {
                    console.error("[Client] Server WebSocket error:", serverMessage.error);
                    setError(`Server error: ${serverMessage.error}`);
                    toast({ title: "Translation Error", description: serverMessage.error, variant: "destructive" });
                    setIsProcessingServer(false);
                } else if (serverMessage.message) {
                    console.log("[Client] Informational message from server:", serverMessage.message);
                }
            } catch (e) {
                console.error("[Client] Error processing server message:", e, "Raw data:", event.data);
            }
        };

        newWs.onerror = (event) => {
            if (ws.current !== newWs) {
                 console.log("[Client] onerror: Stale WebSocket instance. Ignoring error.");
                 // This instance (newWs) is errored, ensure it's closed if not already
                 if (newWs.readyState !== WebSocket.CLOSED && newWs.readyState !== WebSocket.CLOSING) {
                    newWs.close(1000, "Stale onerror cleanup");
                 }
                // Do not reject here for stale instances, only if the *current* attempt fails.
                return;
            }
            console.error("[Client] WebSocket error (client-side):", event);
            setError("WebSocket connection failed. Check console.");
            setIsProcessingServer(false);
            if (streamingStateRef.current !== "error") setStreamingState("error");
            toast({ title: "Connection Error", description: "Could not connect to WebSocket server.", variant: "destructive" });
            ws.current = null; // Nullify the current ref as this attempt failed
            reject(new Error("WebSocket connection error"));
        };

        newWs.onclose = (event) => {
            if (ws.current !== newWs && ws.current !== null) { // If ws.current is null, this specific newWs might have been the one that just closed.
                console.log(`[Client] onclose: Stale or already replaced WebSocket instance (URL: ${newWs.url}, Code: ${event.code}). Ignoring.`);
                return;
            }
            console.log(`[Client] WebSocket disconnected (client-side). Code: ${event.code}, Reason: "${event.reason}", Clean: ${event.wasClean}.`);
            
            // Only set error and toast if the closure was unexpected and not part of a deliberate stop/unmount.
            if (event.code !== 1000 && streamingStateRef.current !== "idle" && streamingStateRef.current !== "stopping" && streamingStateRef.current !== "error") {
                setError("WebSocket connection lost. Try restarting transcription.");
                if (!event.wasClean) {
                    toast({ title: "Connection Lost", description: "Connection to the server was interrupted.", variant: "destructive" });
                }
                 if (streamingStateRef.current !== "error") setStreamingState("error");
            }
            setIsProcessingServer(false);
            // If this closing instance is indeed the one referenced by ws.current, nullify it.
            if (ws.current === newWs) {
                ws.current = null;
            }
        };
    });
  }, [toast]);


  useEffect(() => {
    console.log("[Client] Main useEffect: Setting up...");
    const mimeTypes = [
      'audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm', 'audio/mp4',
    ];
    const foundMimeType = mimeTypes.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));

    if (foundMimeType) {
      console.log(`[Client] Using supported MimeType: ${foundMimeType}`);
      setSupportedMimeType(foundMimeType);
    } else {
      console.warn('[Client] No supported MIME type for MediaRecorder found.');
      setError("Your browser does not support the required audio recording formats.");
      setStreamingState("error");
    }

    // Attempt to connect WebSocket on initial mount
    // connectWebSocket handles not reconnecting if already open/connecting
    connectWebSocket().catch(err => {
        console.warn("[Client] Initial WebSocket connection attempt failed on mount:", err.message);
        // Error state and toast are handled within connectWebSocket for connection-specific errors
    });


    return () => {
      console.log("[Client] Main useEffect: Cleaning up. Current WebSocket state:", ws.current?.readyState);
      if (ws.current) {
        console.log("[Client] Cleaning up WebSocket instance in main useEffect cleanup.");
        ws.current.onopen = null;
        ws.current.onmessage = null;
        ws.current.onerror = null;
        ws.current.onclose = null; // Crucial: Nullify onclose before closing
        if (ws.current.readyState === WebSocket.OPEN || ws.current.readyState === WebSocket.CONNECTING) {
          ws.current.close(1000, "Component unmounting");
        }
        ws.current = null;
      }
      stopInternals(true); // Stop MediaRecorder and associated streams

      console.log("[Client] Main useEffect: Cleanup finished.");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array ensures this runs only on mount and unmount

  const startMediaRecorder = useCallback(async (): Promise<boolean> => {
    console.log("[Client] Initiating startMediaRecorder");
    if (!supportedMimeType) {
      setError("Audio format not supported for recording.");
      toast({ title: "Recording Error", description: "Audio format not supported.", variant: "destructive" });
      // Do not set streamingState here, let startTranscriptionCycle handle failure.
      return false;
    }

    // Clean up previous MediaRecorder instance if any
    if (mediaRecorderRef.current) {
        console.warn("[Client] Existing MediaRecorder found. Cleaning up old MR and stream.");
        mediaRecorderRef.current.ondataavailable = null;
        mediaRecorderRef.current.onstop = null;
        mediaRecorderRef.current.onerror = null;
        if (mediaRecorderRef.current.stream && mediaRecorderRef.current.stream.active) {
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
        if (mediaRecorderRef.current.state !== "inactive") {
            try { mediaRecorderRef.current.stop(); } catch(e) {console.warn("Error stopping old MR in startMediaRecorder", e)}
        }
        mediaRecorderRef.current = null;
    }

    // Clean up previous system audio stream if switching to system audio or restarting
    if (systemAudioStreamRef.current && systemAudioStreamRef.current.active && audioInputModeRef.current === "system") {
        console.warn("[Client] Existing systemAudioStreamRef found. Stopping its tracks before getting new one.");
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
    }

    let stream: MediaStream;
    try {
      if (audioInputModeRef.current === "system") {
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true, audio: { suppressLocalAudioPlayback: false } as any,
        });
        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length > 0) {
            stream = new MediaStream(audioTracks);
            displayStream.getVideoTracks().forEach(track => track.stop());
            systemAudioStreamRef.current = stream;
        } else {
            const noAudioMsg = "No audio track found in the selected screen/tab source.";
            setError(noAudioMsg);
            toast({ title: "Audio Capture Error", description: noAudioMsg, variant: "destructive" });
            displayStream.getTracks().forEach(track => track.stop());
            return false;
        }
      } else {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      console.log(`[Client] New MediaRecorder created for mode: ${audioInputModeRef.current}. MimeType: ${supportedMimeType}. Stream ID: ${stream.id}`);

      mediaRecorderRef.current.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0 && ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(event.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
        console.log(`[Client] MR.onstop (recording complete) for mode ${audioInputModeRef.current}.`);
        if (mediaRecorderRef.current?.stream) {
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
        if (audioInputModeRef.current === "system" && systemAudioStreamRef.current === mediaRecorderRef.current?.stream) {
            systemAudioStreamRef.current = null;
        }
        // Avoid setting state here directly, stopInternals or stopTranscriptionCycle should handle it
      };
      
      mediaRecorderRef.current.onerror = (event: Event) => {
        console.error("[Client] MediaRecorder error:", event);
        setError("Error during audio recording.");
        toast({ title: "Recording Error", description: "An error occurred with the audio recorder.", variant: "destructive" });
        // Let startTranscriptionCycle or other callers handle state transition to 'error'
        // Potentially call stopInternals here or rely on the main error handling flow
        if (streamingStateRef.current !== "idle" && streamingStateRef.current !== "stopping") {
            stopTranscriptionCycle(); // Try to gracefully stop everything on MR error.
        }
      };

      mediaRecorderRef.current.start(MEDIA_RECORDER_TIMESLICE_MS);
      console.log(`[Client] MediaRecorder started with timeslice ${MEDIA_RECORDER_TIMESLICE_MS}ms.`);
      return true;

    } catch (err: any) {
      console.error(`[Client] Error starting MediaRecorder (mode ${audioInputModeRef.current}):`, err);
      let userMessage = `Failed to start audio capture: ${err.message}`;
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
         userMessage = audioInputModeRef.current === "system" ? "Permission for screen/tab capture denied." : "Microphone permission denied.";
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError"){
         userMessage = audioInputModeRef.current === "system" ? "No screen/tab capture source found." : "No microphone found.";
      } else if (err.name === "AbortError") {
        userMessage = "Screen/tab capture canceled by user.";
      }
      setError(userMessage);
      toast({ title: "Capture Error", description: userMessage, variant: "destructive" });
      if (systemAudioStreamRef.current && audioInputModeRef.current === "system") {
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
      }
      return false;
    }
  }, [supportedMimeType, toast, audioInputModeRef]); // Added audioInputModeRef


  const stopInternals = useCallback((isUnmounting = false) => {
    console.log("[Client] Calling stopInternals.", { isUnmounting, currentMRState: mediaRecorderRef.current?.state });

    if (mediaRecorderRef.current) {
      console.log("[Client] MR: Cleaning up handlers and stopping in stopInternals. Current state:", mediaRecorderRef.current.state);
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.onerror = null;

      if (mediaRecorderRef.current.stream && mediaRecorderRef.current.stream.active) {
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
      if (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused") {
        try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Error stopping MR in stopInternals", e);}
      }
      mediaRecorderRef.current = null;
    }
    
    if (systemAudioStreamRef.current && systemAudioStreamRef.current.active) {
        console.log(`[Client] stopInternals: Explicitly stopping systemAudioStreamRef tracks (isUnmounting: ${isUnmounting}).`);
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
    }
  }, []);


  const startTranscriptionCycle = useCallback(async () => {
    console.log(`[Client] Attempting to start transcription cycle. Current state: ${streamingStateRef.current} Source Lang: ${sourceLanguage}, Target Lang: ${targetLanguage}, Audio Mode: ${audioInputModeRef.current}`);

    if (error) setError(null);
    setTranscribedText("");
    setTranslatedText("");

    try {
        // Ensure WebSocket is connected first
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
            console.log("[Client] WebSocket not connected in startTranscriptionCycle. Attempting to connect...");
            await connectWebSocket(); // connectWebSocket returns a promise

            // Simple wait for connection after attempt, can be made more robust
            if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
                 await new Promise(r => setTimeout(r, 500)); // wait a bit more
            }
            if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
                setError("Failed to connect to WebSocket. Please try again.");
                toast({ title: "Connection Failed", description: "Could not connect to the server.", variant: "destructive"});
                setStreamingState("error"); // Set error state before returning
                setIsProcessingServer(false);
                return;
            }
        }
        
        // Then start media recorder
        const mediaRecorderStarted = await startMediaRecorder();
        if (!mediaRecorderStarted) {
          // startMediaRecorder handles setting its own error state and toast
          setStreamingState("error"); // Ensure main state reflects this failure
          setIsProcessingServer(false);
          return;
        }

        // If both WebSocket and MediaRecorder are ready, proceed
        setStreamingState("recognizing");
        setIsProcessingServer(true);
        
        console.log("[Client] Sending start_transcription_stream to server.");
        ws.current.send(JSON.stringify({
          action: 'start_transcription_stream',
          language: sourceLanguage,
          targetLanguage: targetLanguage,
          model: 'base'
        }));

        toast({ title: audioInputModeRef.current === "microphone" ? "Microphone Activated" : "Screen/Tab Capture Activated", description: `Streaming audio (mode: ${audioInputModeRef.current})...` });

    } catch (connectionError: any) {
        console.error("[Client] Error during WebSocket connection or MediaRecorder start in startTranscriptionCycle:", connectionError.message);
        setError(`Failed to start services: ${connectionError.message}`);
        stopInternals(); // Clean up media if it was partially started
        setStreamingState("error");
        setIsProcessingServer(false);
    }
  }, [
    sourceLanguage, targetLanguage, connectWebSocket, toast, 
    startMediaRecorder, stopInternals, error, audioInputModeRef
  ]);


  const stopTranscriptionCycle = useCallback(async () => {
    console.log("[Client] Attempting to stop transcription cycle. Current state (ref):", streamingStateRef.current);
    
    // Set stopping state immediately to prevent new start attempts and update UI
    setStreamingState("stopping"); 

    stopInternals(); // Stop MediaRecorder and associated streams first

    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      console.log("[Client] Sending stop_transcription_stream to server.");
      ws.current.send(JSON.stringify({ action: 'stop_transcription_stream' }));
    } else {
      console.warn("[Client] WebSocket not open. Cannot send stop_transcription_stream. Resources cleaned locally.");
    }
    
    // Reset states after stopping attempts and local cleanup
    // setIsProcessingServer(false); // Should already be false or become false from WS messages/errors
    // No, set it explicitly
    setIsProcessingServer(false);
    setStreamingState("idle"); 
    toast({title: "Transcription Stopped"});
    if (error && streamingStateRef.current === "idle") setError(null); // Clear error if stopping successfully to idle

  }, [stopInternals, error, toast]);


  const handleToggleStreaming = () => {
    console.log("[Client] handleToggleStreaming called. Current state:", streamingStateRef.current);
    if (streamingStateRef.current === "recognizing") {
      stopTranscriptionCycle();
    } else if (streamingStateRef.current === "idle" || streamingStateRef.current === "error") {
      startTranscriptionCycle();
    } else if (streamingStateRef.current === "stopping"){
      toast({title: "Please Wait", description: "Finalizing current recording..."})
    }
  };


  // --- Derived UI State ---
  let StreamButtonIconComponent = Mic;
  let streamButtonText = audioInputMode === "microphone" ? "Start Mic Transcription" : "Start Screen/Tab Record";
  let streamButtonVariant: "default" | "destructive" = "default";
  let statusMessage = "";
  let iconShouldAnimateSpin = false;

  if (streamingState === "recognizing") {
    if (isProcessingServer) {
        StreamButtonIconComponent = Loader2; // Show loader as icon when server is processing
        iconShouldAnimateSpin = true;
        statusMessage = "Server processing audio...";
    } else {
        StreamButtonIconComponent = MicOff; // MicOff when actively streaming but maybe server is caught up
        statusMessage = "Streaming audio...";
    }
    streamButtonText = audioInputMode === "microphone" ? "Stop Mic Transcription" : "Stop Screen/Tab Record";
    streamButtonVariant = "destructive";
  } else if (streamingState === "stopping") {
    StreamButtonIconComponent = Loader2;
    iconShouldAnimateSpin = true;
    streamButtonText = "Stopping...";
    statusMessage = "Finalizing..."
  } else if (streamingState === "error") {
      StreamButtonIconComponent = AlertTriangle; // Use AlertTriangle for error state icon
      if (!supportedMimeType) {
         statusMessage = "Audio recording not supported.";
      } else if (error){
         statusMessage = error;
      } else {
         statusMessage = "An error occurred. Try again.";
      }
      // Keep default button text for retry
  } else if (streamingState === "idle") {
      StreamButtonIconComponent = Mic; // Default icon
      if (error) statusMessage = error;
      // Default button text is already set
  }

  const isButtonDisabled = streamingState === "stopping" || (!supportedMimeType && streamingState !== "error");

  const languageSelectorItems = supportedLanguages.map(lang => ({ ...lang }));


  return (
    <div className="flex flex-col items-center min-h-screen p-4 md:p-8 bg-background text-foreground">
      <header className="w-full max-w-3xl mb-8">
        <div className="flex justify-center items-center mb-2">
          <LinguaVoxLogo className="h-12 w-auto" />
        </div>
        <p className="text-muted-foreground text-lg text-center">
          Real-time Audio Transcription & Translation
        </p>
         <div className="text-center mt-2">
           <Link href="/listener" className="text-sm text-primary hover:underline flex items-center justify-center gap-1">
                <AudioLines size={16}/>
                Go to Listener Page
            </Link>
        </div>
      </header>

      <main className="w-full max-w-3xl">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              Translation Settings
            </CardTitle>
            <CardDescription>
              Select languages and audio source.
              <br/>
              <span className="text-xs text-muted-foreground">
                <strong>Microphone & Screen/Tab Modes:</strong> Streams audio for server-side STT & translation.
                <strong className="text-primary"> For "Screen/Tab", ensure "Share tab audio" or "Share system audio" is checked in the browser dialog.</strong>
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
              <LanguageSelector
                id="source-language"
                label="Source Language (Spoken)"
                value={sourceLanguage}
                onValueChange={(value) => {
                  if (streamingState !== "recognizing" && streamingState !== "stopping") {
                    setSourceLanguage(value);
                  }
                }}
                languages={languageSelectorItems}
                disabled={streamingState === "recognizing" || streamingState === "stopping"}
              />
              <LanguageSelector
                id="target-language"
                label="Target Language (Translation)"
                value={targetLanguage}
                onValueChange={(value) => {
                  setTargetLanguage(value);
                }}
                languages={languageSelectorItems}
                disabled={streamingState === "stopping"} 
              />
              <div className="flex flex-col space-y-2">
                <Label htmlFor="audio-input-mode" className="text-sm font-medium">Audio Source</Label>
                <RadioGroup
                  id="audio-input-mode"
                  value={audioInputMode}
                  onValueChange={(value: string) => {
                     if (streamingState !== "recognizing" && streamingState !== "stopping") {
                       setAudioInputMode(value as AudioInputMode);
                       console.log("[Client] Audio input mode changed to:", value);
                       setTranscribedText(""); 
                       setTranslatedText("");
                     }
                  }}
                  className="flex space-x-2"
                  disabled={streamingState === "recognizing" || streamingState === "stopping"}
                >
                  <div className="flex items-center space-x-1">
                    <RadioGroupItem value="microphone" id="mic-mode" />
                    <Label htmlFor="mic-mode" className="text-sm cursor-pointer"><Mic size={16} className="inline mr-1"/>Microphone</Label>
                  </div>
                  <div className="flex items-center space-x-1">
                    <RadioGroupItem value="system" id="system-mode" />
                    <Label htmlFor="system-mode" className="text-sm cursor-pointer"><ScreenShare size={16} className="inline mr-1"/>Screen/Tab</Label>
                  </div>
                </RadioGroup>
              </div>
            </div>

            <Separator />

            <div className="flex flex-col items-center space-y-4">
              <Button
                onClick={handleToggleStreaming}
                disabled={isButtonDisabled}
                className="w-full md:w-auto px-8 py-6 text-lg transition-all duration-300 ease-in-out transform hover:scale-105"
                variant={streamButtonVariant}
              >
                <StreamButtonIconComponent className={`mr-2 h-6 w-6 ${iconShouldAnimateSpin ? "animate-spin" : ""}`} />
                {streamButtonText}
              </Button>
               <div className="min-h-[20px] flex flex-col items-center justify-center space-y-1 text-sm">
                  {statusMessage && <p className={` ${error || streamingState === 'error' ? 'text-destructive' : 'text-primary'} ${streamingState === "recognizing" || streamingState === "stopping" ? "animate-pulse" : ""}`}>{statusMessage}</p>}
              </div>
            </div>

            {error && streamingState === 'error' && !statusMessage.includes(error) && ( // Show only if error is not already in statusMessage
              <div className="mt-4 p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5"/>
                <p>{error}</p>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
              <div>
                <h3 className="text-xl font-semibold font-headline mb-2 flex items-center gap-2">
                  <Mic className="text-primary"/>
                  Live Transcription (from Server):
                </h3>
                <Textarea
                  value={transcribedText}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Transcribed text from server"
                  placeholder={
                    streamingState === "recognizing" ? "Waiting for server transcription..." : "Server transcription will appear here..."
                  }
                />
              </div>
              <div>
                <h3 className="text-xl font-semibold font-headline mb-2 flex items-center gap-2">
                  <LanguagesIcon className="text-accent"/>
                  Translation:
                </h3>
                <Textarea
                  value={translatedText}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Translated text"
                  placeholder={isProcessingServer && streamingState === "recognizing" ? "Server translating..." : "Translation will appear here..."}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox. All rights reserved.</p>
        <p className="mt-1">
          Audio is streamed to the server for STT (Whisper) and Translation (Genkit).
        </p>
      </footer>
    </div>
  );
}

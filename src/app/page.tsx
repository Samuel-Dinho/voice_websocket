
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

        if (ws.current) {
            console.warn("[Client] Previous WebSocket instance found. Cleaning it up before reconnecting.", {readyState: ws.current.readyState});
            ws.current.onopen = null;
            ws.current.onmessage = null;
            ws.current.onerror = null;
            ws.current.onclose = null;
            if (ws.current.readyState !== WebSocket.CLOSED && ws.current.readyState !== WebSocket.CLOSING) {
                ws.current.close(1000, "Reconnecting: Old instance cleanup");
            }
            ws.current = null;
        }

        const newWs = new WebSocket(WS_URL);
        // Assign early to ws.current for consistent checking in handlers
        // but only consider it "fully connected" in onopen.
        ws.current = newWs; 

        newWs.onopen = () => {
            if (ws.current !== newWs) {
                console.log("[Client] onopen: Stale WebSocket instance. Closing and ignoring.");
                newWs.close(1000, "Stale onopen callback");
                // Do not reject here as a new connection might be in progress or just established.
                return;
            }
            console.log("[Client] WebSocket connected (client-side)");
            setError(null);
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
                    // setIsProcessingServer(false); // Server is still processing future chunks, so keep this true if recognizing
                } else if (serverMessage.error) {
                    console.error("[Client] Server WebSocket error:", serverMessage.error);
                    setError(`Server error: ${serverMessage.error}`);
                    toast({ title: "Translation Error", description: serverMessage.error, variant: "destructive" });
                    setIsProcessingServer(false); // Error means processing stops
                } else if (serverMessage.message) {
                    console.log("[Client] Informational message from server:", serverMessage.message);
                }
            } catch (e) {
                console.error("[Client] Error processing server message:", e, "Raw data:", event.data);
            }
        };

        newWs.onerror = (event) => {
            if (ws.current !== newWs && ws.current !== null) {
                console.log("[Client] onerror: Stale or null WebSocket instance. Ignoring error.");
                // If ws.current points to this instance, nullify it as it's now errored
                if (ws.current === newWs) ws.current = null;
                reject(new Error("Stale WebSocket instance onerror")); // Reject if this specific connection attempt failed
                return;
            }
            console.error("[Client] WebSocket error (client-side):", event);
            setError("WebSocket connection failed. Check console.");
            setIsProcessingServer(false);
            if (streamingStateRef.current !== "error") setStreamingState("error"); // Transition to error state
            toast({ title: "Connection Error", description: "Could not connect to WebSocket server.", variant: "destructive" });
            ws.current = null; // Nullify the ref as it's errored out
            reject(new Error("WebSocket connection error"));
        };

        newWs.onclose = (event) => {
            if (ws.current !== newWs && ws.current !== null) {
                console.log(`[Client] onclose: Stale or null WebSocket instance (URL: ${newWs.url}, Code: ${event.code}). Ignoring.`);
                return;
            }
            console.log(`[Client] WebSocket disconnected (client-side). Code: ${event.code}, Reason: "${event.reason}", Clean: ${event.wasClean}.`);
            if (event.code !== 1000 && streamingStateRef.current !== "idle" && streamingStateRef.current !== "error") {
                setError("WebSocket connection lost. Try restarting transcription.");
                if (!event.wasClean) {
                    toast({ title: "Connection Lost", description: "Connection to the server was interrupted.", variant: "destructive" });
                }
                 if (streamingStateRef.current !== "error") setStreamingState("error");
            }
            setIsProcessingServer(false);
            if (ws.current === newWs) { // Only nullify if it's the current active WS instance
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

    // Attempt to connect WebSocket on initial mount if not already trying
    if (!ws.current || (ws.current.readyState !== WebSocket.OPEN && ws.current.readyState !== WebSocket.CONNECTING)) {
        connectWebSocket().catch(err => {
            console.warn("[Client] Initial WebSocket connection attempt failed on mount:", err.message);
            // Error handling is managed within connectWebSocket (setting error state, toast)
        });
    }


    return () => {
      console.log("[Client] Main useEffect: Cleaning up. Current WebSocket state:", ws.current?.readyState);
      stopInternals(true); // Stop MediaRecorder and associated streams

      if (ws.current) {
        console.log("[Client] Closing WebSocket on component unmount...");
        // Detach handlers before closing to prevent them from firing on a closed/stale instance
        ws.current.onopen = null;
        ws.current.onmessage = null;
        ws.current.onerror = null;
        ws.current.onclose = null;
        if (ws.current.readyState === WebSocket.OPEN || ws.current.readyState === WebSocket.CONNECTING) {
          ws.current.close(1000, "Component unmounting");
        }
        ws.current = null; // Nullify the ref after closing
      }
      console.log("[Client] Main useEffect: Cleanup finished.");
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array ensures this runs only on mount and unmount

  const startMediaRecorder = useCallback(async (): Promise<boolean> => {
    console.log("[Client] Initiating startMediaRecorder");
    if (!supportedMimeType) {
      setError("Audio format not supported for recording.");
      toast({ title: "Recording Error", description: "Audio format not supported.", variant: "destructive" });
      setStreamingState("error");
      setIsProcessingServer(false);
      return false;
    }

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

    if (systemAudioStreamRef.current && systemAudioStreamRef.current.active && audioInputModeRef.current === "system") {
        console.warn("[Client] Existing systemAudioStreamRef found for system mode. Stopping tracks.");
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
            // Stop video tracks immediately as they are not needed
            displayStream.getVideoTracks().forEach(track => track.stop());
            systemAudioStreamRef.current = stream; // Store the system audio stream
        } else {
            const noAudioMsg = "No audio track found in the selected screen/tab source.";
            setError(noAudioMsg);
            toast({ title: "Audio Capture Error", description: noAudioMsg, variant: "destructive" });
            displayStream.getTracks().forEach(track => track.stop()); // Stop all tracks from displayMedia if no audio
            setStreamingState("error");
            setIsProcessingServer(false);
            return false;
        }
      } else { // Microphone mode
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      console.log(`[Client] New MediaRecorder created for mode: ${audioInputModeRef.current}. MimeType: ${supportedMimeType}. Stream ID: ${stream.id}`);

      mediaRecorderRef.current.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0 && ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(event.data);
        } else if (event.data.size > 0) {
          // This warning can be noisy if WS reconnects, consider removing or making less frequent
          // console.warn("[Client] MR.ondataavailable: WebSocket not open or null. Cannot send audio chunk.");
        }
      };

      mediaRecorderRef.current.onstop = () => {
        console.log(`[Client] MR.onstop (recording complete) for mode ${audioInputModeRef.current}. Stream Active: ${mediaRecorderRef.current?.stream?.active}`);
        // The stream associated with THIS MediaRecorder instance should be stopped here.
        if (mediaRecorderRef.current?.stream) {
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
        // If it was system audio, and this was the stream we stored, nullify it.
        // This check is important if onstop fires after a new system stream has already been started by HMR or quick toggle.
        if (audioInputModeRef.current === "system" && systemAudioStreamRef.current === mediaRecorderRef.current?.stream) {
            systemAudioStreamRef.current = null;
        }
      };
      
      mediaRecorderRef.current.onerror = (event: Event) => {
        console.error("[Client] MediaRecorder error:", event);
        setError("Error during audio recording.");
        toast({ title: "Recording Error", description: "An error occurred with the audio recorder.", variant: "destructive" });
        // Transition to error state, which should trigger stopInternals via useEffect on streamingState
        if (streamingStateRef.current !== "error") setStreamingState("error");
        setIsProcessingServer(false);
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
      } else if (err.name === "AbortError") { // User cancelled screen sharing selection
        userMessage = "Screen/tab capture canceled by user.";
      }
      setError(userMessage);
      toast({ title: "Capture Error", description: userMessage, variant: "destructive" });
      // Clean up system audio stream if it was partially acquired
      if (systemAudioStreamRef.current && audioInputModeRef.current === "system") {
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
      }
      setStreamingState("error");
      setIsProcessingServer(false);
      return false;
    }
  }, [supportedMimeType, toast]);


  const stopInternals = useCallback((isUnmounting = false) => {
    console.log("[Client] Calling stopInternals.", { isUnmounting, currentMRState: mediaRecorderRef.current?.state });

    if (mediaRecorderRef.current) {
      console.log("[Client] MR: Cleaning up handlers and stopping in stopInternals. Current state:", mediaRecorderRef.current.state);
      mediaRecorderRef.current.ondataavailable = null; // Detach handlers first
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.onerror = null;

      if (mediaRecorderRef.current.state === "recording" || mediaRecorderRef.current.state === "paused") {
        try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Error stopping MR in stopInternals", e);}
      }
       // Ensure stream associated with this MR is stopped
       if (mediaRecorderRef.current.stream && mediaRecorderRef.current.stream.active) {
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
      mediaRecorderRef.current = null;
    }
    
    // Explicitly stop systemAudioStreamRef if it's still active and we're stopping
    // This is important if system audio was captured but MR didn't fully take it or on unmount
    if (systemAudioStreamRef.current && systemAudioStreamRef.current.active) {
        console.log(`[Client] stopInternals: Explicitly stopping systemAudioStreamRef tracks (isUnmounting: ${isUnmounting}).`);
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
    }
  }, []);


  const startTranscriptionCycle = useCallback(async () => {
    console.log(`[Client] Attempting to start transcription cycle. Current state: ${streamingStateRef.current} Source Lang: ${sourceLanguage}, Target Lang: ${targetLanguage}, Audio Mode: ${audioInputModeRef.current}`);

    if (error) setError(null); // Clear previous errors
    setTranscribedText(""); // Clear previous transcriptions
    setTranslatedText("");

    // Start media recorder first
    const mediaRecorderStarted = await startMediaRecorder();
    if (!mediaRecorderStarted) {
      // startMediaRecorder handles setting error state and toast
      return;
    }

    // Media recorder started successfully, now proceed with WebSocket and state updates
    setStreamingState("recognizing");
    setIsProcessingServer(true);

    try {
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
            console.log("[Client] WebSocket not connected in startTranscriptionCycle. Attempting to connect/reconnect...");
            await connectWebSocket(); // connectWebSocket now returns a promise

            // Polling with timeout to wait for connection
            let attempts = 0;
            const maxAttempts = 10; // e.g., 5 seconds with 500ms interval
            while ((!ws.current || ws.current.readyState !== WebSocket.OPEN) && attempts < maxAttempts) {
                console.log(`[Client] Waiting for WebSocket connection... Attempt ${attempts + 1}/${maxAttempts}`, {readyState: ws.current?.readyState});
                await new Promise(resolveWait => setTimeout(resolveWait, 500));
                attempts++;
            }

            if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
                setError("Failed to connect to WebSocket after starting media. Stopping transcription.");
                toast({ title: "Connection Failed", description: "Could not connect to the server.", variant: "destructive"});
                stopInternals(); // Stop MediaRecorder
                setStreamingState("error");
                setIsProcessingServer(false);
                return;
            }
        }
        
        console.log("[Client] Sending start_transcription_stream to server.");
        ws.current.send(JSON.stringify({
          action: 'start_transcription_stream',
          language: sourceLanguage,
          targetLanguage: targetLanguage,
          model: 'base' // Or make this configurable
        }));

        toast({ title: audioInputModeRef.current === "microphone" ? "Microphone Activated" : "Screen/Tab Capture Activated", description: `Streaming audio (mode: ${audioInputModeRef.current})...` });

    } catch (connectionError: any) {
        console.error("[Client] Error during WebSocket connection in startTranscriptionCycle:", connectionError.message);
        setError(`WebSocket connection failed: ${connectionError.message}`);
        stopInternals(); // Stop MediaRecorder
        setStreamingState("error");
        setIsProcessingServer(false);
    }

  }, [
    sourceLanguage, targetLanguage, connectWebSocket, toast, 
    startMediaRecorder, stopInternals, error // Added error here to clear it
  ]);


  const stopTranscriptionCycle = useCallback(async () => {
    console.log("[Client] Attempting to stop transcription cycle. Current state (ref):", streamingStateRef.current);
    if (streamingStateRef.current === "idle" || streamingStateRef.current === "error") {
      if(error && streamingStateRef.current === "idle") setError(null); // Clear error if stopping from idle
      setIsProcessingServer(false); // Ensure this is false
      return;
    }
    if (streamingStateRef.current === "stopping") {
      console.log("[Client] Already stopping. No action.");
      return; // Already in the process of stopping
    }

    setStreamingState("stopping"); // Indicate stopping process

    stopInternals(); // Stop MediaRecorder and associated streams first

    // Send stop message to server if WebSocket is open
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      console.log("[Client] Sending stop_transcription_stream to server.");
      ws.current.send(JSON.stringify({ action: 'stop_transcription_stream' }));
    } else {
      console.warn("[Client] WebSocket not open. Cannot send stop_transcription_stream. Resources cleaned locally.");
    }
    
    // Reset states after stopping attempts and local cleanup
    setIsProcessingServer(false);
    setStreamingState("idle"); // Transition to idle after stopping
    toast({title: "Transcription Stopped"});

  }, [stopInternals, error, toast]); // Added error to allow clearing


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


  // --- Derived UI State (moved to top of component body for clarity) ---
  let StreamButtonIcon = Mic;
  let streamButtonText = audioInputMode === "microphone" ? "Start Mic Transcription" : "Start Screen/Tab Record";
  let streamButtonVariant: "default" | "destructive" = "default";
  let statusMessage = "";

  if (streamingState === "recognizing") {
    StreamButtonIcon = MicOff;
    streamButtonText = audioInputMode === "microphone" ? "Stop Mic Transcription" : "Stop Screen/Tab Record";
    streamButtonVariant = "destructive";
    if (isProcessingServer) { // isProcessingServer true means we are waiting for server
        statusMessage = "Server processing audio...";
    } else if (!error) { // Should not happen if recognizing, but as a fallback
        statusMessage = "Streaming... Waiting for server...";
    }
  } else if (streamingState === "stopping") {
    StreamButtonIcon = Loader2; // Use Loader2 for stopping state icon as well
    streamButtonText = "Stopping...";
    // streamButtonVariant remains default or whatever it was
  } else if (streamingState === "error") {
      if (!supportedMimeType) {
         statusMessage = "Audio recording not supported.";
      } else if (error){
         statusMessage = error; // Display the actual error message
      } else {
         statusMessage = "An error occurred. Try again.";
      }
  } else if (streamingState === "idle") {
      if (error) statusMessage = error; // Show persistent error if any
      // else: no specific message for idle unless there's an error
  }


  // Button should be disabled if stopping, or if MIME type isn't supported (unless in error state from other cause)
  const isButtonDisabled = streamingState === "stopping" || (!supportedMimeType && streamingState !== "error");
  // Loading indicator for the button content (spinner next to text)
  const isLoadingForButtonSpinner = streamingState === "recognizing" && isProcessingServer;
  // If the ICON itself should be a spinner (e.g. for "stopping" state)
  const isStreamButtonIconLoader = streamingState === "stopping";


  const languageSelectorItems = supportedLanguages.map(lang => ({
    ...lang,
  }));


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
                  setTargetLanguage(value); // Allow changing target language unless actively stopping
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
                       setTranscribedText(""); // Clear text areas when mode changes
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
                {isLoadingForButtonSpinner ? ( 
                  <Loader2 className="mr-2 h-6 w-6 animate-spin" />
                ) : (
                  <StreamButtonIcon className={`mr-2 h-6 w-6 ${isStreamButtonIconLoader ? "animate-spin" : ""}`} />
                )}
                {streamButtonText}
              </Button>
               <div className="min-h-[20px] flex flex-col items-center justify-center space-y-1 text-sm">
                  {statusMessage && <p className={`animate-pulse ${error || streamingState === 'error' ? 'text-destructive' : 'text-primary'}`}>{statusMessage}</p>}
              </div>
            </div>

            {/* This is a more prominent error display area, separate from statusMessage if needed */}
            {error && streamingState === 'error' && (
              <div className="mt-4 p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5"/>
                <p>{error}</p> {/* error state already holds the specific message */}
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



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

const MEDIA_RECORDER_TIMESLICE_MS = 1000; // How often MediaRecorder provides a chunk for system audio

export default function LinguaVoxPage() {
  const ws = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const systemAudioStreamRef = useRef<MediaStream | null>(null); // To hold system audio stream
  const { toast } = useToast();

  const [sourceLanguage, setSourceLanguage] = useState<string>("pt");
  const [targetLanguage, setTargetLanguage] = useState<string>("en");

  const [streamingState, setStreamingState] = useState<StreamingState>("idle");
  const streamingStateRef = useRef<StreamingState>(streamingState); // Ref to get current state in callbacks

  useEffect(() => {
    streamingStateRef.current = streamingState;
  }, [streamingState]);


  const [audioInputMode, setAudioInputMode] = useState<AudioInputMode>("microphone");
  const audioInputModeRef = useRef(audioInputMode); // Ref for current audio input mode
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
    const WS_URL = getWebSocketUrl();
    console.log("[Client] Attempting to connect to WebSocket at:", WS_URL);

    if (ws.current && (ws.current.readyState === WebSocket.OPEN || ws.current.readyState === WebSocket.CONNECTING)) {
      console.log("[Client] WebSocket already connected or connecting.");
      return;
    }
    if (ws.current && ws.current.readyState !== WebSocket.CLOSED) {
        console.warn("[Client] Previous WebSocket instance found and not closed. Closing it before reconnecting.");
        ws.current.onclose = null; // Prevent old onclose from firing
        ws.current.close(1000, "Reconnecting due to new connectWebSocket call");
    }

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      console.log("[Client] WebSocket connected (client-side)");
      setError(null);
      if (streamingStateRef.current === "recognizing" && ws.current && ws.current.readyState === WebSocket.OPEN) {
        console.log("[Client] WS reconnected while recognizing, resending start_transcription_stream command.");
        ws.current?.send(JSON.stringify({
          action: 'start_transcription_stream',
          language: sourceLanguage,
          targetLanguage: targetLanguage,
          model: 'base'
        }));
      }
    };

    ws.current.onmessage = (event) => {
      try {
        const serverMessage = JSON.parse(event.data as string);
        console.log("[Client] Message received from server:", serverMessage);

        if (serverMessage.type === "translated_text_for_listener") {
          setTranslatedText(prev => prev ? prev.trim() + " " + serverMessage.text.trim() : serverMessage.text.trim());
          setIsProcessingServer(false);
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

    ws.current.onerror = (event) => {
      console.error("[Client] WebSocket error (client-side):", event);
      setError("WebSocket connection failed. Check console.");
      setIsProcessingServer(false);
      if(streamingStateRef.current !== "error") setStreamingState("error");
      if (ws.current && ws.current.readyState !== WebSocket.CLOSING && ws.current.readyState !== WebSocket.CLOSED) {
        toast({ title: "Connection Error", description: "Could not connect to WebSocket server.", variant: "destructive" });
      }
    };

    ws.current.onclose = (event) => {
      console.log(`[Client] WebSocket disconnected (client-side). Code: ${event.code}, Reason: "${event.reason}", Clean: ${event.wasClean}.`);
      if (ws.current && ws.current === event.target) {
         ws.current = null;
      }
      if (streamingStateRef.current !== "idle" && streamingStateRef.current !== "error" && event.code !== 1000) {
        setError("WebSocket connection lost. Try restarting transcription.");
        if (!event.wasClean) {
            toast({ title: "Connection Lost", description: "Connection to the server was interrupted.", variant: "destructive" });
        }
        if(streamingStateRef.current !== "error") setStreamingState("error");
      }
      setIsProcessingServer(false);
    };
  }, [sourceLanguage, targetLanguage, toast]);


  useEffect(() => {
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/webm',
      'audio/mp4',
    ];
    const foundMimeType = mimeTypes.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));

    if (foundMimeType) {
      console.log(`[Client] Using supported MimeType: ${foundMimeType}`);
      setSupportedMimeType(foundMimeType);
    } else {
      console.warn('[Client] No supported MIME type for MediaRecorder found.');
      setError("Your browser does not support the required audio recording formats.");
      if (streamingStateRef.current !== 'error') setStreamingState("error");
    }

    connectWebSocket();

    return () => {
      stopInternals(true);
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        console.log("[Client] Closing WebSocket on component unmount...");
        ws.current.send(JSON.stringify({ action: 'stop_transcription_stream' }));
        ws.current.close(1000, "Component unmounting");
      }
      ws.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectWebSocket]);

  const startMediaRecorder = useCallback(async (): Promise<boolean> => {
    console.log("[Client] Initiating startMediaRecorder");
    if (!supportedMimeType) {
      setError("Audio format not supported for recording.");
      toast({ title: "Recording Error", description: "Audio format not supported.", variant: "destructive" });
      setStreamingState("error");
      setIsProcessingServer(false);
      return false;
    }

    audioChunksRef.current = [];

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        console.warn("[Client] Existing MediaRecorder found. Stopping old tracks and MR.");
        if (mediaRecorderRef.current.stream) {
          mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
        if (mediaRecorderRef.current.state === "recording") {
            try { mediaRecorderRef.current.stop(); } catch(e) {console.warn("Error stopping old MR in startMediaRecorder", e)}
        }
        mediaRecorderRef.current = null;
    }

    let stream: MediaStream;
    try {
      if (audioInputModeRef.current === "system") {
        const hasActiveSystemStream = systemAudioStreamRef.current && systemAudioStreamRef.current.getAudioTracks().some(track => track.readyState === 'live');
        if (hasActiveSystemStream) {
            stream = systemAudioStreamRef.current!;
        } else {
            if (systemAudioStreamRef.current) {
                systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
                systemAudioStreamRef.current = null;
            }
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
              video: true, // Often required to get system audio, even if video is discarded
              audio: {
                // @ts-ignore - suppressLocalAudioPlayback might not be in all TS defs
                suppressLocalAudioPlayback: false // Important for user experience
              },
            });
            const audioTracks = displayStream.getAudioTracks();
            if (audioTracks.length > 0) {
                stream = new MediaStream(audioTracks); // Create a new stream with only audio tracks
                displayStream.getVideoTracks().forEach(track => track.stop()); // Stop video tracks if not needed
                systemAudioStreamRef.current = displayStream; // Store original to manage tracks on stop
            } else {
                setError("No audio track found in the selected screen/tab source. Ensure audio sharing is enabled and audio is playing.");
                toast({ title: "Audio Capture Error", description: "Selected source provided no audio or sharing was not permitted.", variant: "destructive" });
                displayStream.getTracks().forEach(track => track.stop());
                setStreamingState("error");
                setIsProcessingServer(false);
                return false;
            }
        }
      } else { // Microphone mode
        if (systemAudioStreamRef.current) { // Clean up system stream if switching modes
            systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
            systemAudioStreamRef.current = null;
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      console.log(`[Client] New MediaRecorder created for mode: ${audioInputModeRef.current}. MimeType: ${supportedMimeType}. Stream ID: ${stream.id}`);

      mediaRecorderRef.current.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0 && ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(event.data);
        } else if (event.data.size > 0) {
          console.warn("[Client] MR.ondataavailable: WebSocket not open or null. Cannot send audio chunk.");
        }
      };

      mediaRecorderRef.current.onstop = () => {
        console.log(`[Client] MR.onstop (recording complete) for mode ${audioInputModeRef.current}.`);
        if (mediaRecorderRef.current?.stream) {
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
        if (audioInputModeRef.current === "system" && systemAudioStreamRef.current) {
           console.log("[Client] MR.onstop (system): Stopping tracks of systemAudioStreamRef.");
           systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
           systemAudioStreamRef.current = null;
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
      
      setStreamingState("error");
      setIsProcessingServer(false);

      if (systemAudioStreamRef.current && audioInputModeRef.current === "system") {
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
      }
      return false;
    }
  }, [supportedMimeType, toast]);


  const stopInternals = useCallback((isUnmounting = false) => {
    console.log("[Client] Calling stopInternals.", { isUnmounting, currentState: streamingStateRef.current });

    if (mediaRecorderRef.current) {
      console.log("[Client] MR: Cleaning up handlers and stopping in stopInternals. Current state:", mediaRecorderRef.current.state);
      mediaRecorderRef.current.ondataavailable = null;
      
      if (mediaRecorderRef.current.state === "recording") {
        try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Error stopping MR in stopInternals (recording)", e);}
      }
      // mediaRecorderRef.current.onstop will handle track stopping for its own stream.
      mediaRecorderRef.current = null;
    }
    
    // Explicitly stop system audio stream tracks if it exists and we are not just unmounting
    // (as onstop might not always fire if the page is quickly closed/refreshed).
    if (audioInputModeRef.current === "system" && systemAudioStreamRef.current) {
        console.log(`[Client] stopInternals: Explicitly stopping systemAudioStreamRef tracks (isUnmounting: ${isUnmounting}).`);
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
    }

    audioChunksRef.current = [];

    // Only change state if not unmounting and not already idle/error.
    // The caller (stopTranscriptionCycle) will set the final state.
    if (!isUnmounting && streamingStateRef.current !== "idle" && streamingStateRef.current !== "error") {
      // Caller will set state to idle or error.
    }
  }, []);


  const startTranscriptionCycle = useCallback(async () => {
    console.log(`[Client] Attempting to start transcription cycle. Current state: ${streamingStateRef.current} Source Lang: ${sourceLanguage}, Target Lang: ${targetLanguage}, Audio Mode: ${audioInputModeRef.current}`);

    if (!supportedMimeType) { 
      setError("Audio format not supported"); 
      setStreamingState("error"); 
      setIsProcessingServer(false); 
      return; 
    }
    if (error) setError(null); // Clear previous errors

    // Attempt to start media recorder first.
    const mediaRecorderStarted = await startMediaRecorder();
    if (!mediaRecorderStarted) {
      // Error already handled and states set by startMediaRecorder
      return;
    }

    // Media recorder started successfully, now proceed with WebSocket and state updates.
    setStreamingState("recognizing");
    setIsProcessingServer(true);


    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        console.log("[Client] WebSocket not connected in startTranscriptionCycle. Attempting reconnect...");
        connectWebSocket(); 
        // Set a timeout to check connection and send start command
        setTimeout(() => {
            if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                console.log("[Client] WS connected after delay, sending start_transcription_stream.");
                ws.current.send(JSON.stringify({
                  action: 'start_transcription_stream',
                  language: sourceLanguage,
                  targetLanguage: targetLanguage,
                  model: 'base'
                }));
                toast({ title: audioInputModeRef.current === "microphone" ? "Microphone Activated" : "Screen/Tab Capture Activated", description: `Streaming audio (mode: ${audioInputModeRef.current})...` });
            } else {
                setError("Failed to connect to WebSocket after starting media. Stopping transcription.");
                toast({ title: "Connection Failed", description: "Could not connect to the server.", variant: "destructive"});
                stopInternals(); // Clean up media
                setStreamingState("error");
                setIsProcessingServer(false);
            }
        }, 1500); // Wait for connection
        return;
    }
    
    console.log("[Client] Sending start_transcription_stream to server.");
    ws.current.send(JSON.stringify({
      action: 'start_transcription_stream',
      language: sourceLanguage,
      targetLanguage: targetLanguage,
      model: 'base'
    }));

    if (streamingStateRef.current === "recognizing" && !error) { // Check error state again
      toast({ title: audioInputModeRef.current === "microphone" ? "Microphone Activated" : "Screen/Tab Capture Activated", description: `Streaming audio (mode: ${audioInputModeRef.current})...` });
    }

  }, [supportedMimeType, sourceLanguage, targetLanguage, connectWebSocket, toast, startMediaRecorder, error]);


  const stopTranscriptionCycle = useCallback(async () => {
    console.log("[Client] Attempting to stop transcription cycle (stopTranscriptionCycle)... Current state (ref):", streamingStateRef.current);
    if (streamingStateRef.current === "idle" || streamingStateRef.current === "error") {
        console.log("[Client] Already idle or in error.");
        if(error && streamingStateRef.current === "idle") setError(null); // Clear error if now idle
        setIsProcessingServer(false);
        return;
    }
    if (streamingStateRef.current === "stopping") {
        console.log("[Client] Already in the process of stopping.");
        return;
    }

    setStreamingState("stopping"); // Indicate stopping process

    // Stop MediaRecorder first
    // stopInternals will handle actual MR.stop() and track cleanup
    stopInternals(); 

    // Send stop command to server
    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      console.log("[Client] Sending stop_transcription_stream to server.");
      ws.current.send(JSON.stringify({ action: 'stop_transcription_stream' }));
    } else {
      console.warn("[Client] WebSocket not open. Cannot send stop_transcription_stream.");
    }
    
    // Final state updates
    setIsProcessingServer(false);
    setStreamingState("idle");
    toast({title: "Transcription Stopped"});

  }, [stopInternals, error, toast]); // Added toast


  const handleToggleStreaming = () => {
    console.log("[Client] handleToggleStreaming called. Current state:", streamingStateRef.current);
    if (streamingStateRef.current === "recognizing") {
      stopTranscriptionCycle();
    } else if (streamingStateRef.current === "idle" || streamingStateRef.current === "error") {
      // Clear previous data and errors before starting
      if(error) setError(null);
      setTranscribedText("");
      setTranslatedText("");
      audioChunksRef.current = []; // Ensure chunks are cleared

      startTranscriptionCycle(); // This will handle WS connection checks internally
    } else if (streamingStateRef.current === "stopping"){
        console.log("[Client] Currently stopping, please wait.");
        toast({title: "Please Wait", description: "Finalizing current recording..."})
    }
  };


  const StreamButtonIcon = streamingState === "recognizing" ? MicOff : Mic;
  let streamButtonText = audioInputMode === "microphone" ? "Start Mic Transcription" : "Start Screen/Tab Record";
  if (streamingState === "recognizing") streamButtonText = audioInputMode === "microphone" ? "Stop Mic Transcription" : "Stop Screen/Tab Record";
  if (streamingState === "stopping") streamButtonText = "Stopping...";

  const isButtonDisabled = streamingState === "stopping" || (!supportedMimeType && streamingState !== "error" && streamingState !== "idle");
  const isLoading = streamingState === "stopping" || (streamingState === "recognizing" && isProcessingServer);


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
                <strong>Microphone Mode:</strong> Streams microphone audio for server-side STT & translation.
                <br />
                <strong>Screen/Tab Mode:</strong> Streams screen/tab audio for server-side STT & translation.
                <strong className="text-primary"> When using "Screen/Tab", ensure "Share tab audio" or "Share system audio" is checked in the browser dialog.</strong> To change source, stop and restart.
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
                    setTargetLanguage(value); // Allow changing target language even while streaming
                }}
                languages={languageSelectorItems}
                disabled={streamingState === "recognizing" || streamingState === "stopping"}
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
                       audioChunksRef.current = [];
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
                variant={streamingState === "recognizing" ? "destructive" : "default"}
              >
                {isLoading || streamingState === "stopping" ? ( // Consolidated loading check
                  <Loader2 className="mr-2 h-6 w-6 animate-spin" />
                ) : (
                  <StreamButtonIcon className="mr-2 h-6 w-6" />
                )}
                {streamButtonText}
              </Button>
               <div className="min-h-[20px] flex flex-col items-center justify-center space-y-1 text-sm">
                  {!supportedMimeType && streamingState !== "error" && streamingState !== "idle" && (
                    <p className="text-destructive">Audio recording not supported.</p>
                  )}
                  {(streamingState === "recognizing") && !isProcessingServer && (
                    <p className="text-primary animate-pulse">Streaming audio to server...</p>
                  )}
                  {isProcessingServer && streamingState === "recognizing" && ( // Show "Server processing" only when recognizing
                    <p className="text-accent animate-pulse">Server processing audio...</p>
                  )}
              </div>
            </div>

            {error && (
              <div className="mt-4 p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5"/>
                <p>{error}</p>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-6">
              <div>
                <h3 className="text-xl font-semibold font-headline mb-2 flex items-center gap-2">
                  <Mic className="text-primary"/>
                  Transcription (from Server):
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

"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Mic, StopCircle, Loader2, Volume2, AlertTriangle, Languages } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { supportedLanguages, type Language } from "@/lib/languages";
import { translateAudio } from "@/ai/flows/translate-audio";
import { useToast } from "@/hooks/use-toast";
import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Separator } from "@/components/ui/separator";

type RecordingState = "idle" | "recording" | "processing" | "error";

export default function LinguaVoxPage() {
  const [sourceLanguage, setSourceLanguage] = useState<string>("en");
  const [targetLanguage, setTargetLanguage] = useState<string>("es");
  const [recordingState, setRecordingState] = useState<RecordingState>("idle");
  const [translatedText, setTranslatedText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const { toast } = useToast();

  const isMicrophoneSupported = () => typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

  useEffect(() => {
    if (!isMicrophoneSupported()) {
      setError("Audio recording is not supported by your browser.");
      setRecordingState("error");
      toast({
        title: "Browser Incompatible",
        description: "Audio recording is not supported by your browser.",
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleStartRecording = async () => {
    if (!isMicrophoneSupported()) {
      setError("Audio recording not supported.");
      toast({ title: "Error", description: "Audio recording not supported.", variant: "destructive" });
      return;
    }

    setError(null);
    setTranslatedText("");
    setRecordingState("recording");
    audioChunksRef.current = [];

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream);
      mediaRecorderRef.current.ondataavailable = (event) => {
        audioChunksRef.current.push(event.data);
      };
      mediaRecorderRef.current.onstop = async () => {
        setRecordingState("processing");
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" }); // Genkit might prefer specific types, check docs. webm is common.
        
        // Convert Blob to Data URI
        const reader = new FileReader();
        reader.onloadend = async () => {
          const audioDataUri = reader.result as string;
          try {
            const translationOutput = await translateAudio({
              audioDataUri,
              sourceLanguage,
              targetLanguage,
            });
            setTranslatedText(translationOutput.translatedText);
            setRecordingState("idle");
          } catch (aiError) {
            console.error("AI Translation Error:", aiError);
            setError("Translation failed. Please try again.");
            setRecordingState("error");
            toast({
              title: "Translation Error",
              description: (aiError as Error)?.message || "An unknown error occurred during translation.",
              variant: "destructive",
            });
          }
        };
        reader.onerror = () => {
          console.error("File Reader Error");
          setError("Failed to process audio data.");
          setRecordingState("error");
          toast({ title: "Audio Processing Error", description: "Could not read audio data.", variant: "destructive"});
        }
        reader.readAsDataURL(audioBlob);
        
        // Stop all tracks on the stream to release the microphone
        stream.getTracks().forEach(track => track.stop());
      };
      mediaRecorderRef.current.start();
    } catch (err) {
      console.error("Microphone Access Error:", err);
      let message = "Could not access microphone.";
      if (err instanceof Error && err.name === "NotAllowedError") {
        message = "Microphone permission denied. Please enable it in your browser settings.";
      } else if (err instanceof Error && err.name === "NotFoundError") {
        message = "No microphone found. Please connect a microphone.";
      }
      setError(message);
      setRecordingState("error");
      toast({ title: "Microphone Error", description: message, variant: "destructive"});
    }
  };

  const handleStopRecording = () => {
    if (mediaRecorderRef.current && recordingState === "recording") {
      mediaRecorderRef.current.stop();
      // The rest of the logic is in onstop handler
    }
  };
  
  const playTranslatedText = useCallback(() => {
    if (typeof window !== 'undefined' && translatedText && window.speechSynthesis) {
      const utterance = new SpeechSynthesisUtterance(translatedText);
      utterance.lang = targetLanguage; // Set language for TTS
      window.speechSynthesis.speak(utterance);
    } else if (translatedText) {
      toast({
        title: "TTS Not Supported",
        description: "Your browser does not support text-to-speech or no text to play.",
        variant: "default",
      });
    }
  }, [translatedText, targetLanguage, toast]);


  const RecordButtonIcon = recordingState === "recording" ? StopCircle : Mic;
  const recordButtonText = recordingState === "recording" ? "Stop Recording" : "Start Recording";
  const isButtonDisabled = recordingState === "processing" || recordingState === "error" && !isMicrophoneSupported();

  return (
    <div className="flex flex-col items-center min-h-screen p-4 md:p-8 bg-background text-foreground">
      <header className="w-full max-w-3xl mb-8 text-center">
        <div className="flex justify-center items-center mb-2">
          <LinguaVoxLogo className="h-12 w-auto" />
        </div>
        <p className="text-muted-foreground text-lg">
          Real-time Audio Translation Powered by Local AI
        </p>
      </header>

      <main className="w-full max-w-3xl">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Languages className="text-primary" />
              Translator
            </CardTitle>
            <CardDescription>
              Select your source and target languages, then record your audio.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <LanguageSelector
                id="source-language"
                label="Source Language"
                value={sourceLanguage}
                onValueChange={setSourceLanguage}
                languages={supportedLanguages}
                disabled={recordingState === "recording" || recordingState === "processing"}
              />
              <LanguageSelector
                id="target-language"
                label="Target Language"
                value={targetLanguage}
                onValueChange={setTargetLanguage}
                languages={supportedLanguages}
                disabled={recordingState === "recording" || recordingState === "processing"}
              />
            </div>

            <Separator />

            <div className="flex flex-col items-center space-y-4">
              <Button
                onClick={recordingState === "recording" ? handleStopRecording : handleStartRecording}
                disabled={isButtonDisabled}
                className="w-full md:w-auto px-8 py-6 text-lg transition-all duration-300 ease-in-out transform hover:scale-105"
                variant={recordingState === "recording" ? "destructive" : "default"}
              >
                {recordingState === "processing" ? (
                  <Loader2 className="mr-2 h-6 w-6 animate-spin" />
                ) : (
                  <RecordButtonIcon className="mr-2 h-6 w-6" />
                )}
                {recordingState === "processing" ? "Processing..." : recordButtonText}
              </Button>
              {recordingState === "recording" && (
                 <p className="text-sm text-muted-foreground animate-pulse">Recording audio...</p>
              )}
            </div>

            {error && (
              <div className="mt-4 p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5"/> 
                <p>{error}</p>
              </div>
            )}
            
            {translatedText && recordingState !== "processing" && (
              <div className="mt-6 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="text-xl font-semibold font-headline">Translation:</h3>
                  <Button variant="ghost" size="icon" onClick={playTranslatedText} title="Play translated text">
                    <Volume2 className="h-5 w-5 text-primary"/>
                    <span className="sr-only">Play audio</span>
                  </Button>
                </div>
                <Textarea
                  value={translatedText}
                  readOnly
                  rows={6}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Translated text"
                />
              </div>
            )}
          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox. All rights reserved.</p>
        <p className="mt-1">Designed for seamless local audio translation.</p>
      </footer>
    </div>
  );
}

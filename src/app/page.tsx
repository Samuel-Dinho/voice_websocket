
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Mic, MicOff, Loader2, Volume2, AlertTriangle, Languages, Power } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { supportedLanguages, type Language } from "@/lib/languages";
// A função translateAudio não será chamada diretamente pelo cliente com WebSockets
// import { translateAudio } from "@/ai/flows/translate-audio"; 
import { useToast } from "@/hooks/use-toast";
import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Separator } from "@/components/ui/separator";

const WEBSOCKET_URL = process.env.NEXT_PUBLIC_WEBSOCKET_URL || (typeof window !== 'undefined' ? (window.location.protocol === 'https:' ? 'wss://' : 'ws://') + window.location.host + '/api/translate-stream' : 'ws://localhost:3000/api/translate-stream');
const AUDIO_TIMESLICE_MS = 1000; // Enviar áudio a cada 1 segundo

type StreamingState = "idle" | "connecting" | "streaming" | "error" | "stopping";

export default function LinguaVoxPage() {
  const [sourceLanguage, setSourceLanguage] = useState<string>("en");
  const [targetLanguage, setTargetLanguage] = useState<string>("es");
  const [streamingState, setStreamingState] = useState<StreamingState>("idle");
  const [translatedText, setTranslatedText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const { toast } = useToast();

  const isMicrophoneSupported = () => typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.getUserMedia;

  useEffect(() => {
    if (!isMicrophoneSupported()) {
      setError("Gravação de áudio não é suportada pelo seu navegador.");
      setStreamingState("error");
      toast({
        title: "Navegador Incompatível",
        description: "Gravação de áudio não é suportada pelo seu navegador.",
        variant: "destructive",
      });
    }
  }, [toast]);

  const connectWebSocket = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      return;
    }

    setStreamingState("connecting");
    setError(null);
    setTranslatedText("");

    const ws = new WebSocket(WEBSOCKET_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WebSocket connected");
      setStreamingState("streaming");
      startStreamingAudio();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string);
        if (message.translatedText) {
          setTranslatedText((prev) => prev + (prev ? " " : "") + message.translatedText);
        } else if (message.error) {
          console.error("WebSocket error message:", message.error);
          setError(`Erro do servidor: ${message.error}`);
          // Não pararemos o streaming por erros de tradução individuais,
          // a menos que sejam fatais para a conexão.
        }
      } catch (e) {
        console.error("Failed to parse WebSocket message:", e);
        //setError("Recebeu dados inválidos do servidor.");
      }
    };

    ws.onerror = (event) => {
      console.error("WebSocket error:", event);
      setError("Falha na conexão com o servidor de tradução. Tente novamente.");
      setStreamingState("error");
      stopStreamingAudio(); // Garante que o microfone seja liberado
    };

    ws.onclose = (event) => {
      console.log("WebSocket disconnected", event.reason);
      if (streamingState !== "idle" && streamingState !== "stopping") {
        // Se a desconexão não foi intencional
        // setError("Desconectado do servidor de tradução.");
        // setStreamingState("error");
      }
      stopStreamingAudio(); // Garante que o microfone seja liberado
    };
  }, [sourceLanguage, targetLanguage, streamingState]); // Adicionado sourceLanguage e targetLanguage

  const startStreamingAudio = async () => {
    if (!isMicrophoneSupported() || !wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      setError("Não é possível iniciar o streaming: microfone não suportado ou WebSocket não conectado.");
      setStreamingState("error");
      return;
    }

    try {
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(streamRef.current);
      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          audioChunksRef.current.push(event.data);
          const audioBlob = new Blob(audioChunksRef.current, { type: "audio/webm" });
          audioChunksRef.current = []; // Limpar para o próximo chunk

          const reader = new FileReader();
          reader.onloadend = () => {
            const audioDataUri = reader.result as string;
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify({
                audioDataUri,
                sourceLanguage,
                targetLanguage,
              }));
            }
          };
          reader.onerror = () => {
             console.error("File Reader Error for audio chunk");
             toast({ title: "Erro ao Processar Áudio", description: "Não foi possível ler um pedaço do áudio.", variant: "destructive"});
          }
          reader.readAsDataURL(audioBlob);
        }
      };
      
      mediaRecorderRef.current.onstart = () => {
        setStreamingState("streaming");
      };

      mediaRecorderRef.current.onstop = () => {
        // Lógica de parada já está em stopStreamingAudio e ws.onclose
      };
      
      mediaRecorderRef.current.start(AUDIO_TIMESLICE_MS);

    } catch (err) {
      console.error("Microphone Access Error:", err);
      let message = "Não foi possível acessar o microfone.";
      if (err instanceof Error && err.name === "NotAllowedError") {
        message = "Permissão do microfone negada. Por favor, habilite nas configurações do seu navegador.";
      } else if (err instanceof Error && err.name === "NotFoundError") {
        message = "Nenhum microfone encontrado. Por favor, conecte um microfone.";
      }
      setError(message);
      setStreamingState("error");
      toast({ title: "Erro de Microfone", description: message, variant: "destructive"});
      if (wsRef.current) wsRef.current.close(); // Fecha o websocket se o microfone falhar
    }
  };

  const stopStreamingAudio = useCallback(() => {
    setStreamingState("stopping");
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close(1000, "Client initiated disconnect");
      }
      wsRef.current = null;
    }
    setStreamingState("idle");
  }, []);


  const handleToggleStreaming = () => {
    if (streamingState === "streaming" || streamingState === "connecting") {
      stopStreamingAudio();
    } else {
      connectWebSocket();
    }
  };
  
  // Limpeza ao desmontar o componente
  useEffect(() => {
    return () => {
      stopStreamingAudio();
    };
  }, [stopStreamingAudio]);

  const playTranslatedText = useCallback(() => {
    if (typeof window !== 'undefined' && translatedText && window.speechSynthesis) {
      // Para o TTS anterior se estiver falando
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(translatedText);
      // Tenta encontrar a voz correspondente ao targetLanguage
      const voices = window.speechSynthesis.getVoices();
      const targetVoice = voices.find(voice => voice.lang.startsWith(targetLanguage));
      if (targetVoice) {
        utterance.voice = targetVoice;
      } else {
        utterance.lang = targetLanguage; // Fallback para o seletor de idioma do navegador
      }
      window.speechSynthesis.speak(utterance);
    } else if (translatedText) {
      toast({
        title: "TTS Não Suportado",
        description: "Seu navegador não suporta text-to-speech ou não há texto para tocar.",
        variant: "default",
      });
    }
  }, [translatedText, targetLanguage, toast]);


  const StreamButtonIcon = (streamingState === "streaming" || streamingState === "connecting") ? MicOff : Mic;
  let streamButtonText = "Iniciar Transmissão";
  if (streamingState === "connecting") streamButtonText = "Conectando...";
  if (streamingState === "streaming") streamButtonText = "Parar Transmissão";
  if (streamingState === "stopping") streamButtonText = "Parando...";
  
  const isButtonDisabled = streamingState === "connecting" || streamingState === "stopping" || (streamingState === "error" && !isMicrophoneSupported());
  const isLoading = streamingState === "connecting" || streamingState === "stopping";

  return (
    <div className="flex flex-col items-center min-h-screen p-4 md:p-8 bg-background text-foreground">
      <header className="w-full max-w-3xl mb-8 text-center">
        <div className="flex justify-center items-center mb-2">
          <LinguaVoxLogo className="h-12 w-auto" />
        </div>
        <p className="text-muted-foreground text-lg">
          Tradução de Áudio em Tempo Real via WebSocket
        </p>
      </header>

      <main className="w-full max-w-3xl">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Languages className="text-primary" />
              Tradutor Contínuo
            </CardTitle>
            <CardDescription>
              Selecione os idiomas e inicie a transmissão para tradução em tempo real.
              <br/>
              <span className="text-xs text-muted-foreground">Nota: Um servidor WebSocket em {WEBSOCKET_URL.replace(/^wss?:\/\//, '')} precisa estar em execução.</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <LanguageSelector
                id="source-language"
                label="Idioma de Origem"
                value={sourceLanguage}
                onValueChange={setSourceLanguage}
                languages={supportedLanguages}
                disabled={streamingState === "streaming" || streamingState === "connecting"}
              />
              <LanguageSelector
                id="target-language"
                label="Idioma de Destino"
                value={targetLanguage}
                onValueChange={setTargetLanguage}
                languages={supportedLanguages}
                disabled={streamingState === "streaming" || streamingState === "connecting"}
              />
            </div>

            <Separator />

            <div className="flex flex-col items-center space-y-4">
              <Button
                onClick={handleToggleStreaming}
                disabled={isButtonDisabled}
                className="w-full md:w-auto px-8 py-6 text-lg transition-all duration-300 ease-in-out transform hover:scale-105"
                variant={(streamingState === "streaming" || streamingState === "connecting") ? "destructive" : "default"}
              >
                {isLoading ? (
                  <Loader2 className="mr-2 h-6 w-6 animate-spin" />
                ) : (
                  <StreamButtonIcon className="mr-2 h-6 w-6" />
                )}
                {streamButtonText}
              </Button>
              {(streamingState === "streaming") && (
                 <p className="text-sm text-primary animate-pulse">Transmitindo áudio...</p>
              )}
            </div>

            {error && (
              <div className="mt-4 p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5"/> 
                <p>{error}</p>
              </div>
            )}
            
            {translatedText && (
              <div className="mt-6 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="text-xl font-semibold font-headline">Tradução:</h3>
                  <Button variant="ghost" size="icon" onClick={playTranslatedText} title="Ouvir tradução">
                    <Volume2 className="h-5 w-5 text-primary"/>
                    <span className="sr-only">Ouvir áudio</span>
                  </Button>
                </div>
                <Textarea
                  value={translatedText}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Texto traduzido"
                />
              </div>
            )}
          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox. Todos os direitos reservados.</p>
        <p className="mt-1">Projetado para tradução de áudio local e contínua.</p>
      </footer>
    </div>
  );
}



"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Mic, MicOff, Loader2, AlertTriangle, Languages, Edit3 } from "lucide-react"; // Import Edit3 for transcription icon
import { LanguageSelector } from "@/components/LanguageSelector";
import { supportedLanguages } from "@/lib/languages";
import { useToast } from "@/hooks/use-toast";
import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Separator } from "@/components/ui/separator";

const WEBSOCKET_URL = process.env.NEXT_PUBLIC_WEBSOCKET_URL || 'ws://localhost:3001';
const AUDIO_TIMESLICE_MS = 1000;

type StreamingState = "idle" | "connecting" | "streaming" | "error" | "stopping";

export default function LinguaVoxPage() {
  const [sourceLanguage, setSourceLanguage] = useState<string>("en");
  // targetLanguage state is removed as we are focusing on transcription
  const [streamingState, setStreamingState] = useState<StreamingState>("idle");
  const [transcribedText, setTranscribedText] = useState<string>(""); // Renamed from translatedText
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
      console.log("[Client] WebSocket já está conectado.");
      if (streamingState !== "streaming") {
         setStreamingState("streaming");
         startStreamingAudio();
      }
      return;
    }

    setStreamingState("connecting");
    setError(null);
    setTranscribedText(""); // Clear transcribed text on new connection

    console.log(`[Client] Tentando conectar ao WebSocket em: ${WEBSOCKET_URL}`);
    const ws = new WebSocket(WEBSOCKET_URL);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("[Client] WebSocket connected (client-side)");
      startStreamingAudio();
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string);
        if (message.transcribedText) { // Expecting transcribedText now
          setTranscribedText((prev) => prev + (prev ? " " : "") + message.transcribedText);
        } else if (message.error) {
          console.error("[Client] WebSocket error message from server:", message.error);
          setError(`Erro do servidor: ${message.error}`);
           toast({
            title: "Erro de Transcrição",
            description: message.error,
            variant: "destructive",
          });
        } else if (message.message) {
          console.log("[Client] Mensagem informativa do servidor:", message.message);
        }
      } catch (e) {
        console.error("[Client] Failed to parse WebSocket message:", e, "Data received:", event.data);
      }
    };

    ws.onerror = (event) => {
      console.error("[Client] WebSocket error (client-side). Event details:", event);
      setError("Falha na conexão com o servidor de transcrição. Verifique se o servidor WebSocket está rodando e acessível.");
      setStreamingState("error");
      toast({
        title: "Erro de WebSocket",
        description: `Não foi possível conectar a ${WEBSOCKET_URL}. Verifique o console do servidor WebSocket e do navegador.`,
        variant: "destructive",
      });
    };

    ws.onclose = (event) => {
      console.log(`[Client] WebSocket disconnected (client-side). Code: ${event.code}, Reason: "${event.reason}", WasClean: ${event.wasClean}. Event details:`, event);
      if (streamingState !== "idle" && streamingState !== "stopping") {
        if (!error || event.code !== 1006) { 
            setError(error || `Desconectado do servidor de transcrição. Código: ${event.code}`);
        }
        setStreamingState("error");
      }
      
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
    };
  // targetLanguage removed from dependencies
  }, [sourceLanguage, streamingState, toast, error]);

  const startStreamingAudio = async () => {
    if (!isMicrophoneSupported()){
      setError("Microfone não suportado.");
      setStreamingState("error");
      return;
    }
    if(!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      console.warn("[Client] Tentativa de iniciar áudio sem WebSocket conectado ou não aberto.");
      setError("Não é possível iniciar o streaming: WebSocket não conectado.");
      setStreamingState("error"); 
      return;
    }

    try {
      console.log("[Client] Requisitando acesso ao microfone...");
      streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      console.log("[Client] Acesso ao microfone concedido.");
      setStreamingState("streaming");
      toast({ title: "Microfone Ativado", description: "Iniciando transmissão de áudio para transcrição."});

      const MimeTypesToTry = [
        'audio/ogg;codecs=opus',
        'audio/webm;codecs=opus', 
        'audio/ogg', 
        'audio/webm', 
      ];
      let selectedMimeType: string | undefined = undefined;
      let mediaRecorderOptions: MediaRecorderOptions | undefined = undefined;

      for (const mimeType of MimeTypesToTry) {
        if (MediaRecorder.isTypeSupported(mimeType)) {
          selectedMimeType = mimeType;
          mediaRecorderOptions = { mimeType: selectedMimeType };
          console.log(`[Client] MIME type ${mimeType} é suportado.`);
          break;
        } else {
          console.log(`[Client] MIME type ${mimeType} NÃO é suportado.`);
        }
      }

      if (selectedMimeType && mediaRecorderOptions) {
        console.log(`[Client] Usando mimeType suportado: ${selectedMimeType}`);
        mediaRecorderRef.current = new MediaRecorder(streamRef.current!, mediaRecorderOptions);
      } else {
        console.warn("[Client] Nenhum dos mimeTypes preferidos é suportado. Usando o padrão do navegador para MediaRecorder.");
        mediaRecorderRef.current = new MediaRecorder(streamRef.current!);
      }
      console.log("[Client] MediaRecorder inicializado com mimeType efetivo:", mediaRecorderRef.current.mimeType);


      audioChunksRef.current = [];

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0 && wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          audioChunksRef.current.push(event.data);
          const blobMimeType = mediaRecorderRef.current!.mimeType; 
          const audioBlob = new Blob(audioChunksRef.current, { type: blobMimeType });
          audioChunksRef.current = [];

          const reader = new FileReader();
          reader.onloadend = () => {
            const audioDataUri = reader.result as string;
            if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
               console.log(`[Client] Enviando audioDataUri (início: ${audioDataUri.substring(0,60)}..., tipo blob: ${blobMimeType}, tamanho total: ${audioDataUri.length})`);
              wsRef.current.send(JSON.stringify({
                audioDataUri,
                sourceLanguage,
                targetLanguage: "xx", // Placeholder, as targetLanguage is not used by the flow now
              }));
            }
          };
          reader.onerror = (e) => {
             console.error("[Client] Erro do FileReader ao processar chunk de áudio:", e);
             toast({ title: "Erro ao Processar Áudio", description: "Não foi possível ler um pedaço do áudio.", variant: "destructive"});
          }
          reader.readAsDataURL(audioBlob);
        }
      };
      
      mediaRecorderRef.current.onstop = () => {
        console.log("[Client] MediaRecorder parado (cliente).");
      };
      
      mediaRecorderRef.current.onerror = (event) => {
        console.error("[Client] Erro do MediaRecorder (cliente):", event);
        setError("Erro com o gravador de mídia.");
        setStreamingState("error");
        stopStreamingAudio();
        toast({ title: "Erro de Gravação", description: "Ocorreu um problema com o gravador de áudio.", variant: "destructive"});
      };
      
      mediaRecorderRef.current.start(AUDIO_TIMESLICE_MS);

    } catch (err) {
      console.error("[Client] Erro ao acessar microfone ou iniciar MediaRecorder:", err);
      let message = "Não foi possível acessar o microfone ou iniciar a gravação.";
      if (err instanceof Error) {
          if (err.name === "NotAllowedError") {
            message = "Permissão do microfone negada. Por favor, habilite nas configurações do seu navegador.";
          } else if (err.name === "NotFoundError") {
            message = "Nenhum microfone encontrado. Por favor, conecte um microfone.";
          } else {
            message = `Erro de microfone: ${err.message}`;
          }
      }
      setError(message);
      setStreamingState("error");
      toast({ title: "Erro de Microfone", description: message, variant: "destructive"});
      if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
        wsRef.current.close(1006, "Falha no acesso ao microfone ou MediaRecorder");
      }
    }
  };

  const stopStreamingAudio = useCallback(() => {
    console.log("[Client] Parando streaming de áudio (cliente)...");
    setStreamingState("stopping");

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.stop();
      console.log("[Client] MediaRecorder.stop() chamado (cliente).");
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      console.log("[Client] Trilhas de mídia paradas (cliente).");
    }

    if (wsRef.current) {
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        console.log("[Client] Fechando WebSocket (cliente)...");
        wsRef.current.close(1000, "Client initiated disconnect");
      }
    }
    
    setTimeout(() => {
        setStreamingState("idle");
        console.log("[Client] Streaming efetivamente parado (cliente), estado = idle.");
    }, 500); 
  }, []);


  const handleToggleStreaming = () => {
    if (streamingState === "streaming" || streamingState === "connecting") {
      stopStreamingAudio();
    } else {
      connectWebSocket(); 
    }
  };
  
  useEffect(() => {
    return () => {
      console.log("[Client] Componente desmontando, garantindo parada do streaming...");
      stopStreamingAudio();
    };
  }, [stopStreamingAudio]);

  // playTranslatedText is removed as we are not translating now

  const StreamButtonIcon = (streamingState === "streaming" || streamingState === "connecting") ? MicOff : Mic;
  let streamButtonText = "Iniciar Transcrição"; // Changed from "Iniciar Transmissão"
  if (streamingState === "connecting") streamButtonText = "Conectando...";
  if (streamingState === "streaming") streamButtonText = "Parar Transcrição"; // Changed
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
          Transcrição de Áudio em Tempo Real via WebSocket
        </p>
      </header>

      <main className="w-full max-w-3xl">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Edit3 className="text-primary" /> {/* Changed icon to Edit3 for transcription */}
              Transcritor Contínuo
            </CardTitle>
            <CardDescription>
              Selecione o idioma de origem e inicie para transcrição em tempo real.
              <br/>
              <span className="text-xs text-muted-foreground">Nota: Um servidor WebSocket em {WEBSOCKET_URL.replace(/^wss?:\/\//, '')} precisa estar em execução.</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-1 gap-6"> {/* Changed to 1 column */}
              <LanguageSelector
                id="source-language"
                label="Idioma de Origem do Áudio"
                value={sourceLanguage}
                onValueChange={(value) => {
                  if (streamingState !== "streaming" && streamingState !== "connecting") {
                    setSourceLanguage(value);
                  }
                }}
                languages={supportedLanguages}
                disabled={streamingState === "streaming" || streamingState === "connecting"}
              />
              {/* TargetLanguageSelector removed */}
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
                 <p className="text-sm text-primary animate-pulse">Transmitindo áudio para transcrição...</p>
              )}
            </div>

            {error && (
              <div className="mt-4 p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5"/> 
                <p>{error}</p>
              </div>
            )}
            
            {transcribedText && ( // Changed from translatedText
              <div className="mt-6 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="text-xl font-semibold font-headline">Transcrição:</h3>
                  {/* Play button removed */}
                </div>
                <Textarea
                  value={transcribedText} // Changed from translatedText
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Texto transcrito" // Changed
                />
              </div>
            )}
          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox. Todos os direitos reservados.</p>
        <p className="mt-1">Projetado para transcrição de áudio local e contínua.</p>
      </footer>
    </div>
  );
}

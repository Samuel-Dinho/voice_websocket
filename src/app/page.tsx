
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Mic, MicOff, Loader2, AlertTriangle, Edit3, LanguagesIcon, PlaySquare } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { supportedLanguages } from "@/lib/languages";
import { useToast } from "@/hooks/use-toast";
import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Separator } from "@/components/ui/separator";
import Link from "next/link";

type StreamingState = "idle" | "recognizing" | "error" | "stopping";

let recognition: SpeechRecognition | null = null;

export default function LinguaVoxPage() {
  const ws = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const { toast } = useToast();

  const [sourceLanguage, setSourceLanguage] = useState<string>("pt");
  const [targetLanguage, setTargetLanguage] = useState<string>("en");
  const [streamingState, setStreamingState] = useState<StreamingState>("idle");
  const [transcribedText, setTranscribedText] = useState<string>("");
  const [interimTranscribedText, setInterimTranscribedText] = useState<string>("");
  const [translatedText, setTranslatedText] = useState<string>("");
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [supportedMimeType, setSupportedMimeType] = useState<string | null>(null);


  const getWebSocketUrl = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = process.env.NEXT_PUBLIC_WEBSOCKET_PORT || '3001';
    return `${protocol}//${window.location.hostname}:${wsPort}`;
  };

  const connectWebSocket = useCallback(() => {
    const WS_URL = getWebSocketUrl();
    console.log("[Client] Tentando conectar ao WebSocket em:", WS_URL);

    if (ws.current && ws.current.readyState === WebSocket.OPEN) {
      console.log("[Client] WebSocket já está conectado.");
      return;
    }

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      console.log("[Client] WebSocket conectado (client-side)");
      setError(null);
    };

    ws.current.onmessage = (event) => {
      try {
        const serverMessage = JSON.parse(event.data as string);
        console.log("[Client] Mensagem recebida do servidor:", serverMessage);

        if (serverMessage.translatedText) {
          setTranslatedText(prev => prev ? prev.trim() + " " + serverMessage.translatedText.trim() : serverMessage.translatedText.trim());
          setIsTranslating(false);
        } else if (serverMessage.error) {
          console.error("[Client] Erro do servidor WebSocket:", serverMessage.error);
          setError(`Erro do servidor: ${serverMessage.error}`);
          toast({ title: "Erro na Tradução", description: serverMessage.error, variant: "destructive" });
          setIsTranslating(false);
        } else if (serverMessage.message) {
          console.log("[Client] Mensagem informativa do servidor:", serverMessage.message);
        }
      } catch (e) {
        console.error("[Client] Erro ao processar mensagem do servidor:", e);
        setError("Erro ao processar resposta do servidor.");
        setIsTranslating(false);
      }
    };

    ws.current.onerror = (event) => {
      console.error("[Client] Erro no WebSocket (client-side):", event);
      setError("Falha na conexão WebSocket. Verifique o console.");
      setStreamingState("error");
      setIsTranslating(false);
      toast({ title: "Erro de Conexão", description: "Não foi possível conectar ao servidor WebSocket.", variant: "destructive" });
    };

    ws.current.onclose = (event) => {
      console.log(`[Client] WebSocket desconectado (client-side). Código: ${event.code}, Razão: "${event.reason}", Foi Limpo: ${event.wasClean}. Detalhes do evento:`, event);
      if (streamingState === "recognizing" || streamingState === "stopping") {
        // Only set to idle if it was actively recognizing/stopping, not if it was already idle due to an error elsewhere
         setStreamingState("idle");
      }
       if (ws.current && ws.current === event.target) { // Check if the closed ws is the current one
        ws.current = null; // Clear the ref
      }
    };
  }, [streamingState, toast]);

  useEffect(() => {
    connectWebSocket();
    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/webm',
      'audio/mp4',
    ];
    const foundMimeType = mimeTypes.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
    if (foundMimeType) {
      console.log(`[Client] Usando mimeType suportado: ${foundMimeType}`);
      setSupportedMimeType(foundMimeType);
    } else {
      console.warn('[Client] Nenhum MIME type suportado para MediaRecorder encontrado.');
      setError("Seu navegador não suporta gravação de áudio nos formatos necessários.");
    }

    return () => {
      if (recognition) {
        recognition.abort();
        recognition = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
      }
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        console.log("[Client] Fechando WebSocket ao desmontar o componente...");
        ws.current.close(1000, "Component unmounting");
      }
      ws.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectWebSocket]);


  const isSpeechRecognitionSupported = useCallback(() => {
    return typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  }, []);

  useEffect(() => {
    if (!isSpeechRecognitionSupported()) {
      setError("Reconhecimento de fala não é suportado pelo seu navegador.");
      setStreamingState("error");
      toast({
        title: "Navegador Incompatível",
        description: "Seu navegador não suporta a API Web Speech para reconhecimento de fala.",
        variant: "destructive",
      });
    }
  }, [toast, isSpeechRecognitionSupported]);


  const startMediaRecorder = async () => {
    if (!supportedMimeType) {
      toast({ title: "Erro de Gravação", description: "Formato de áudio não suportado para gravação.", variant: "destructive" });
      return false;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop(); // Stop previous if any
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      audioChunksRef.current = []; // Clear previous chunks

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorderRef.current.onstop = () => {
        // This onstop will be primarily for when SpeechRecognition ends a segment.
        // The stream tracks are stopped in stopRecognition more globally.
        console.log("[Client] MediaRecorder parado (onstop).");
      };
      mediaRecorderRef.current.start(); // Start immediately
      console.log("[Client] MediaRecorder iniciado.");
      return true;
    } catch (err) {
      console.error("[Client] Erro ao iniciar MediaRecorder:", err);
      setError("Falha ao acessar o microfone para gravação de áudio.");
      toast({ title: "Erro de Microfone", description: "Não foi possível iniciar a gravação de áudio.", variant: "destructive" });
      return false;
    }
  };


  const startRecognition = useCallback(async () => {
    console.log("[Client] Tentando iniciar reconhecimento. Estado atual:", streamingState, "Idioma Fonte:", sourceLanguage);
    if (!isSpeechRecognitionSupported()) {
      setError("Reconhecimento de fala não suportado.");
      setStreamingState("error");
      toast({ title: "Erro Crítico", description: "API de Reconhecimento de Fala não disponível.", variant: "destructive" });
      return;
    }
     if (!supportedMimeType) {
      setError("Gravação de áudio não é suportada pelo seu navegador.");
      setStreamingState("error");
      toast({ title: "Navegador Incompatível", description: "Seu navegador não suporta gravação de áudio.", variant: "destructive" });
      return;
    }

    if (streamingState === "recognizing") {
      console.warn("[Client] Tentando iniciar reconhecimento quando já está em progresso.");
      return;
    }

    setStreamingState("recognizing");
    setError(null);
    setTranscribedText("");
    setInterimTranscribedText("");
    setTranslatedText("");
    

    const mediaRecorderStarted = await startMediaRecorder();
    if (!mediaRecorderStarted) {
      setStreamingState("error");
      return;
    }
    
    toast({ title: "Microfone Ativado", description: "Iniciando reconhecimento e gravação..." });

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
        setError("API de Reconhecimento de Fala não encontrada no navegador.");
        setStreamingState("error");
        toast({ title: "Erro Crítico", description: "API de Reconhecimento de Fala não encontrada.", variant: "destructive" });
        return;
    }
    
    try {
      recognition = new SpeechRecognitionAPI();
    } catch (e: any) {
      console.error("[Client] Erro ao criar instância de SpeechRecognition:", e);
      setError(`Erro ao criar SpeechRecognition: ${e.message}`);
      setStreamingState("error");
      toast({ title: "Erro de Inicialização", description: `Não foi possível criar SpeechRecognition: ${e.message}`, variant: "destructive" });
      return;
    }
    
    recognition.continuous = true;
    recognition.interimResults = true;
    const speechLang = sourceLanguage === "en" ? "en-US" :
                       sourceLanguage === "es" ? "es-ES" :
                       sourceLanguage === "fr" ? "fr-FR" :
                       sourceLanguage === "de" ? "de-DE" :
                       sourceLanguage === "it" ? "it-IT" :
                       sourceLanguage === "pt" ? "pt-BR" :
                       sourceLanguage; // Fallback to the code itself
    recognition.lang = speechLang;
    console.log(`[Client] Instância SpeechRecognition criada. Idioma: ${recognition.lang}`);

    recognition.onstart = () => {
      console.log("[Client] SpeechRecognition iniciado com sucesso.");
      setStreamingState("recognizing"); // Ensure state is set
    };

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let final_transcript = '';
      let interim_transcript = '';

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        if (event.results[i].isFinal) {
          final_transcript += event.results[i][0].transcript;
        } else {
          interim_transcript += event.results[i][0].transcript;
        }
      }
      
      setInterimTranscribedText(interim_transcript.trim());

      if (final_transcript.trim()) {
         const newFinalText = final_transcript.trim();
         setTranscribedText(prev => (prev ? prev.trim() + " " : "") + newFinalText);
         setInterimTranscribedText(""); // Clear interim when final is processed

         // Stop current MediaRecorder, process chunks, and send
         if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
           mediaRecorderRef.current.onstop = () => { // Define onstop right before stopping
             console.log("[Client] MediaRecorder parado para enviar segmento.");
             if (audioChunksRef.current.length > 0 && supportedMimeType) {
               const audioBlob = new Blob(audioChunksRef.current, { type: supportedMimeType });
               const reader = new FileReader();
               reader.onloadend = () => {
                 const audioDataUri = reader.result as string;
                 if (ws.current && ws.current.readyState === WebSocket.OPEN) {
                   console.log(`[Client] Enviando texto final "${newFinalText}" e áudio para processamento.`);
                   setIsTranslating(true);
                   ws.current.send(JSON.stringify({
                     action: "process_speech",
                     transcribedText: newFinalText,
                     sourceLanguage: sourceLanguage,
                     targetLanguage: targetLanguage,
                     audioDataUri: audioDataUri
                   }));
                 } else {
                   console.warn("[Client] WebSocket não está aberto. Não é possível enviar dados.");
                   setError("Conexão WebSocket perdida.");
                   setIsTranslating(false);
                   if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
                     console.log("[Client] Tentando reconectar WebSocket...");
                     connectWebSocket();
                   }
                 }
               };
               reader.readAsDataURL(audioBlob);
             }
             audioChunksRef.current = []; // Clear chunks for the next segment
             // Restart MediaRecorder for the next segment if still recognizing
             if (streamingState === "recognizing" && recognition) {
                startMediaRecorder(); 
             }
           };
           mediaRecorderRef.current.stop();
         }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error("[Client] Erro no SpeechRecognition:", event);
      let errMessage = `Erro no reconhecimento: ${event.error}`;
      if (event.error === 'network') errMessage = "Erro de rede durante o reconhecimento.";
      else if (event.error === 'no-speech') errMessage = "Nenhuma fala detectada. Silêncio prolongado?";
      else if (event.error === 'audio-capture') errMessage = "Falha na captura de áudio. Verifique permissões.";
      else if (event.error === 'not-allowed') errMessage = "Permissão do microfone negada.";
      else if (event.error === 'language-not-supported') errMessage = `Idioma '${recognition?.lang}' não suportado.`;
      else if (event.message) errMessage += `. Detalhes: ${event.message}`;
      
      setError(errMessage);
      toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
      // Don't set streamingState to error here if it's 'no-speech' or a recoverable error
      // Let onend handle the state if recognition truly stops.
      if (recognition && (event.error !== 'no-speech')) { // Stop if it's a critical error
        if (streamingState === "recognizing" || streamingState === "stopping") {
           stopRecognitionInternals(); // Call a helper to stop both
        }
      } else if (event.error === 'no-speech' && streamingState === "recognizing") {
        // If 'no-speech', MediaRecorder might still be running. Stop it.
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = () => { // process any remaining audio
                 console.log("[Client] MediaRecorder parado devido a 'no-speech'.");
                 audioChunksRef.current = [];
                 if (streamingState === "recognizing") startMediaRecorder(); // Restart for next attempt
            }
            mediaRecorderRef.current.stop();
        }
      }
    };

    recognition.onend = () => {
      console.log("[Client] SpeechRecognition finalizado. Estado atual:", streamingState);
      // This onend can be triggered by speech inactivity or by calling .stop()
      // Only change state to idle if we are not already in 'stopping' (which will set to idle)
      // or if an error didn't already set it.
      if (streamingState === "recognizing") { // If it ended unexpectedly
        setStreamingState("idle");
        setInterimTranscribedText("");
         if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.stop(); // Ensure recorder is stopped
        }
      }
      // Do not nullify global `recognition` here if `stopRecognition` handles it
    };
    
    console.log("[Client] Chamando recognition.start()...");
    try {
      recognition.start();
    } catch (e: any) {
      console.error("[Client] Erro ao chamar recognition.start():", e);
      setError(`Erro ao iniciar reconhecimento: ${e.message}`);
      setStreamingState("error");
      toast({ title: "Erro ao Iniciar", description: `Não foi possível iniciar o reconhecimento: ${e.message}`, variant: "destructive" });
      stopRecognitionInternals();
    }
  }, [sourceLanguage, targetLanguage, toast, streamingState, isSpeechRecognitionSupported, connectWebSocket, supportedMimeType]);

  const stopRecognitionInternals = () => {
    if (recognition) {
      try {
        recognition.stop();
        console.log("[Client] recognition.stop() chamado internamente.");
      } catch (e: any)
      {
         console.error("[Client] Erro ao chamar recognition.stop() internamente:", e);
      }
      // recognition = null; // Nullify here as it's being stopped
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.onstop = null; // Clear specific onstop before generic stop
      mediaRecorderRef.current.stop();
      console.log("[Client] MediaRecorder.stop() chamado internamente.");
      // Stop media stream tracks
      const stream = mediaRecorderRef.current.stream;
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
        console.log("[Client] Trilhas de mídia paradas (interno).");
      }
    }
    audioChunksRef.current = [];
  };

  const stopRecognition = useCallback(() => {
    console.log("[Client] Tentando parar reconhecimento...");
    if (streamingState !== "recognizing" && streamingState !== "stopping") {
        console.log("[Client] Não estava reconhecendo, definindo para idle.");
        setStreamingState("idle");
        return;
    }
    setStreamingState("stopping"); // Indicate we are in the process of stopping

    stopRecognitionInternals();

    // Recognition.onend will eventually set state to idle
    // Set a timeout to forcefully set to idle if onend doesn't fire quickly
    // This also helps ensure media recorder is fully stopped.
    setTimeout(() => {
        setStreamingState("idle");
        setInterimTranscribedText("");
        console.log("[Client] Streaming efetivamente parado (cliente) após timeout, estado = idle.");
    }, 500); // Adjust timeout as needed

  }, [streamingState]);


  const handleToggleStreaming = () => {
    console.log("[Client] handleToggleStreaming chamado. Estado atual:", streamingState);
    if (streamingState === "recognizing") {
      stopRecognition();
    } else if (streamingState === "idle" || streamingState === "error") { // Allow restart from error state
       if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        console.log("[Client] WebSocket não está conectado. Tentando reconectar antes de iniciar o reconhecimento...");
        connectWebSocket(); // Attempt to reconnect
        // Consider delaying startRecognition until WebSocket is confirmed open, or handle failure
      }
      startRecognition();
    }
  };
  

  const StreamButtonIcon = streamingState === "recognizing" ? MicOff : Mic;
  let streamButtonText = "Iniciar Transcrição";
  if (streamingState === "recognizing") streamButtonText = "Parar Transcrição";
  if (streamingState === "stopping") streamButtonText = "Parando...";
  
  const isButtonDisabled = streamingState === "stopping" || !supportedMimeType;
  const isLoading = streamingState === "stopping" || isTranslating;


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
          Transcrição e Tradução de Áudio em Tempo Real
        </p>
         <div className="text-center mt-2">
            <Link href="/listener" legacyBehavior>
              <a className="text-sm text-primary hover:underline flex items-center justify-center gap-1">
                <PlaySquare size={16} />
                Ir para a Página do Ouvinte
              </a>
            </Link>
        </div>
      </header>

      <main className="w-full max-w-3xl">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Edit3 className="text-primary" />
              Transcritor e Tradutor
            </CardTitle>
            <CardDescription>
              Selecione os idiomas, inicie a transcrição e gravação. O áudio será enviado para tradução e para a página do ouvinte.
               <br/>
              <span className="text-xs text-muted-foreground">Transcrição via API Web Speech. Gravação via MediaRecorder. Tradução via servidor.</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <LanguageSelector
                id="source-language"
                label="Idioma de Origem (Fala)"
                value={sourceLanguage}
                onValueChange={(value) => {
                  if (streamingState !== "recognizing" && streamingState !== "stopping") {
                    setSourceLanguage(value);
                    console.log("[Client] Idioma Fonte alterado para:", value);
                  }
                }}
                languages={languageSelectorItems}
                disabled={streamingState === "recognizing" || streamingState === "stopping"}
              />
              <LanguageSelector
                id="target-language"
                label="Idioma de Destino (Tradução)"
                value={targetLanguage}
                onValueChange={(value) => {
                    setTargetLanguage(value);
                    console.log("[Client] Idioma Destino alterado para:", value);
                }}
                languages={languageSelectorItems}
                disabled={streamingState === "recognizing" || streamingState === "stopping"}
              />
            </div>

            <Separator />

            <div className="flex flex-col items-center space-y-4">
              <Button
                onClick={handleToggleStreaming}
                disabled={isButtonDisabled}
                className="w-full md:w-auto px-8 py-6 text-lg transition-all duration-300 ease-in-out transform hover:scale-105"
                variant={streamingState === "recognizing" ? "destructive" : "default"}
              >
                {isLoading ? (
                  <Loader2 className="mr-2 h-6 w-6 animate-spin" />
                ) : (
                  <StreamButtonIcon className="mr-2 h-6 w-6" />
                )}
                {streamButtonText}
              </Button>
              {!supportedMimeType && (
                <p className="text-sm text-destructive">Gravação de áudio não suportada neste navegador.</p>
              )}
              {(streamingState === "recognizing") && !isTranslating && (
                 <p className="text-sm text-primary animate-pulse">Reconhecendo e gravando...</p>
              )}
              {isTranslating && (
                 <p className="text-sm text-accent animate-pulse">Traduzindo...</p>
              )}
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
                  Transcrição:
                </h3>
                <Textarea
                  value={transcribedText + (interimTranscribedText ? (transcribedText ? " " : "") + interimTranscribedText : "")}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Texto transcrito"
                />
              </div>
              <div>
                <h3 className="text-xl font-semibold font-headline mb-2 flex items-center gap-2">
                  <LanguagesIcon className="text-accent"/>
                  Tradução:
                </h3>
                <Textarea
                  value={translatedText}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Texto traduzido"
                  placeholder={isTranslating ? "Traduzindo..." : "A tradução aparecerá aqui..."}
                />
              </div>
            </div>

          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox. Todos os direitos reservados.</p>
        <p className="mt-1">Transcrição local via Web Speech API. Gravação local via MediaRecorder. Tradução via servidor Genkit.</p>
      </footer>
    </div>
  );
}

    

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

    if (ws.current && (ws.current.readyState === WebSocket.OPEN || ws.current.readyState === WebSocket.CONNECTING)) {
      console.log("[Client] WebSocket já está conectado ou conectando.");
      return;
    }

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      console.log("[Client] WebSocket conectado (client-side)");
      setError(null); // Clear previous errors on successful connection
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
      // Avoid setting streamingState to error if it's a recoverable network blip,
      // let higher-level logic handle streaming state based on recognition.
      setIsTranslating(false);
      toast({ title: "Erro de Conexão", description: "Não foi possível conectar ao servidor WebSocket.", variant: "destructive" });
    };

    ws.current.onclose = (event) => {
      console.log(`[Client] WebSocket desconectado (client-side). Código: ${event.code}, Razão: "${event.reason}", Foi Limpo: ${event.wasClean}.`);
      // Only set to idle if it was actively recognizing/stopping.
      // Avoid changing state if it was already idle due to an error elsewhere or user action.
      if (streamingState === "recognizing" || streamingState === "stopping") {
         setStreamingState("idle");
      }
      // Clear the ref only if the closing WebSocket is the current one.
      if (ws.current && ws.current === event.target) {
        ws.current = null;
      }
    };
  }, [streamingState, toast]); // streamingState dependency helps re-evaluate ws.current.onclose logic if state changes

  useEffect(() => {
    connectWebSocket(); // Initial connection attempt

    const mimeTypes = [
      'audio/webm;codecs=opus',
      'audio/ogg;codecs=opus',
      'audio/webm', // Generic webm, often opus or vp8/vp9
      'audio/mp4', // Can be AAC or other codecs
    ];
    const foundMimeType = mimeTypes.find(type => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type));
    
    if (foundMimeType) {
      console.log(`[Client] Usando mimeType suportado: ${foundMimeType}`);
      setSupportedMimeType(foundMimeType);
    } else {
      console.warn('[Client] Nenhum MIME type suportado para MediaRecorder encontrado. A gravação de áudio pode não funcionar.');
      setError("Seu navegador não suporta gravação de áudio nos formatos necessários.");
      // We don't set streamingState to error here, let the startRecognition attempt fail if needed.
    }

    return () => {
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onstart = null;
        recognition.onend = null;
        recognition.abort(); // More forceful stop
        recognition = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.stop();
        // Stop media stream tracks to release microphone
        const stream = mediaRecorderRef.current.stream;
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        mediaRecorderRef.current = null;
      }
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        console.log("[Client] Fechando WebSocket ao desmontar o componente...");
        ws.current.close(1000, "Component unmounting");
      }
      ws.current = null; // Ensure ws.current is null on unmount
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectWebSocket]); // connectWebSocket is stable due to its own useCallback


  const isSpeechRecognitionSupported = useCallback(() => {
    return typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  }, []);

  useEffect(() => {
    if (!isSpeechRecognitionSupported()) {
      setError("Reconhecimento de fala não é suportado pelo seu navegador.");
      setStreamingState("error"); // This is a critical error for the app's function
      toast({
        title: "Navegador Incompatível",
        description: "Seu navegador não suporta a API Web Speech para reconhecimento de fala.",
        variant: "destructive",
      });
    }
  }, [toast, isSpeechRecognitionSupported]);


  const startMediaRecorder = useCallback(async () => {
    if (!supportedMimeType) {
      setError("Formato de áudio não suportado para gravação.");
      toast({ title: "Erro de Gravação", description: "Formato de áudio não suportado.", variant: "destructive" });
      return false;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        console.log("[Client] MediaRecorder já está gravando. Parando o anterior antes de reiniciar.");
        mediaRecorderRef.current.stop(); // Stop previous if any, onstop will handle chunks if needed (though likely none)
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      audioChunksRef.current = []; // CRUCIAL: Clear previous chunks for the new recording session

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      // mediaRecorderRef.current.onstop is defined dynamically where stop() is called.

      mediaRecorderRef.current.start(); // Start immediately
      console.log("[Client] MediaRecorder iniciado.");
      return true;
    } catch (err) {
      console.error("[Client] Erro ao iniciar MediaRecorder:", err);
      setError("Falha ao acessar o microfone para gravação de áudio.");
      toast({ title: "Erro de Microfone", description: "Não foi possível iniciar a gravação de áudio.", variant: "destructive" });
      return false;
    }
  }, [supportedMimeType, toast]);


  const stopRecognitionInternals = useCallback(() => {
    console.log("[Client] Chamando stopRecognitionInternals. Estado atual:", streamingState);
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onend = null; // Remove listener to prevent onend logic during intentional stop
      try {
        recognition.stop(); // This will trigger its 'onend' if not removed, but we want specific control
        console.log("[Client] recognition.stop() chamado internamente.");
      } catch (e) {
         console.error("[Client] Erro ao chamar recognition.stop() internamente:", e);
      }
      recognition = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
      mediaRecorderRef.current.onstop = () => { // Generic onstop for cleanup
          console.log("[Client] MediaRecorder parado por stopRecognitionInternals.");
          // Stop media stream tracks to release microphone
            const stream = mediaRecorderRef.current?.stream;
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                console.log("[Client] Trilhas de mídia paradas (interno via stopRecognitionInternals).");
            }
            mediaRecorderRef.current = null; // Clear ref after stopping tracks
      };
      mediaRecorderRef.current.stop();
    } else if (mediaRecorderRef.current) { // If not recording but ref exists
        const stream = mediaRecorderRef.current.stream;
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        mediaRecorderRef.current = null;
    }
    audioChunksRef.current = [];
    setInterimTranscribedText("");
  }, [streamingState]); // Include streamingState if its value influences cleanup logic

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

    if (streamingState === "recognizing" || streamingState === "stopping") {
      console.warn("[Client] Tentando iniciar reconhecimento quando já está em progresso ou parando.");
      return;
    }
    
    // Ensure WebSocket is connected or try to connect
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        console.log("[Client] WebSocket não conectado. Tentando reconectar antes de iniciar o reconhecimento...");
        connectWebSocket(); // Attempt to reconnect
        // Wait a brief moment for connection, or handle this more robustly with a ready state check
        await new Promise(resolve => setTimeout(resolve, 500)); 
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
            setError("Falha ao conectar ao WebSocket. Não é possível iniciar a transcrição.");
            toast({ title: "Erro de Conexão", description: "Servidor WebSocket indisponível.", variant: "destructive" });
            setStreamingState("error");
            return;
        }
    }

    setStreamingState("recognizing");
    setError(null);
    setTranscribedText("");
    setInterimTranscribedText("");
    setTranslatedText("");
    
    const mediaRecorderStarted = await startMediaRecorder();
    if (!mediaRecorderStarted) {
      setStreamingState("error"); // startMediaRecorder already shows a toast
      stopRecognitionInternals(); // Clean up anything partially started
      return;
    }
    
    toast({ title: "Microfone Ativado", description: "Iniciando reconhecimento e gravação..." });

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
        setError("API de Reconhecimento de Fala não encontrada no navegador.");
        setStreamingState("error");
        toast({ title: "Erro Crítico", description: "API de Reconhecimento de Fala não encontrada.", variant: "destructive" });
        stopRecognitionInternals();
        return;
    }
    
    try {
      if (recognition) { // Ensure any old instance is fully gone
        recognition.abort();
        recognition = null;
      }
      recognition = new SpeechRecognitionAPI();
    } catch (e: any) {
      console.error("[Client] Erro ao criar instância de SpeechRecognition:", e);
      setError(`Erro ao criar SpeechRecognition: ${e.message}`);
      setStreamingState("error");
      toast({ title: "Erro de Inicialização", description: `Não foi possível criar SpeechRecognition: ${e.message}`, variant: "destructive" });
      stopRecognitionInternals();
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
                       sourceLanguage; 
    recognition.lang = speechLang;
    console.log(`[Client] Instância SpeechRecognition criada. Idioma: ${recognition.lang}`);

    recognition.onstart = () => {
      console.log("[Client] SpeechRecognition iniciado com sucesso.");
      setStreamingState("recognizing"); 
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
         setInterimTranscribedText(""); 

         if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
           mediaRecorderRef.current.onstop = () => { 
             console.log("[Client] MediaRecorder parado para enviar segmento (onresult).");
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
                   console.warn("[Client] WebSocket não está aberto. Não é possível enviar dados. Tentando reconectar...");
                   setError("Conexão WebSocket perdida. Tentando reconectar...");
                   setIsTranslating(false);
                   connectWebSocket(); // Attempt to reconnect
                 }
               };
               reader.readAsDataURL(audioBlob);
             }
             audioChunksRef.current = []; 
             
             // Restart MediaRecorder for the next segment IF still recognizing
             if (streamingState === "recognizing" && recognition) { 
                console.log("[Client] Reiniciando MediaRecorder para o próximo segmento.");
                startMediaRecorder(); 
             } else {
                console.log("[Client] Não reiniciando MediaRecorder, estado não é 'recognizing' ou recognition é nulo.");
             }
           };
           mediaRecorderRef.current.stop();
         } else if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "recording") {
            // If recorder was stopped by something else but we have final text
            console.warn("[Client] MediaRecorder não estava gravando durante onresult final, mas há texto. Tentando reiniciar se necessário.");
            if (streamingState === "recognizing" && recognition) {
                startMediaRecorder();
            }
         }
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error("[Client] Erro no SpeechRecognition:", event.error, event.message);
      let errMessage = `Erro no reconhecimento: ${event.error}`;
      if (event.error === 'network') errMessage = "Erro de rede durante o reconhecimento.";
      else if (event.error === 'no-speech') errMessage = "Nenhuma fala detectada. Microfone mudo ou silêncio?";
      else if (event.error === 'audio-capture') errMessage = "Falha na captura de áudio. Verifique permissões do microfone.";
      else if (event.error === 'not-allowed') errMessage = "Permissão do microfone negada.";
      else if (event.error === 'language-not-supported') errMessage = `Idioma '${recognition?.lang}' não suportado pelo motor de reconhecimento.`;
      else if (event.message) errMessage += `. Detalhes: ${event.message}`;
      
      setError(errMessage);
      toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
      
      if (event.error === 'no-speech') {
        if (streamingState === "recognizing") {
          // Restart MediaRecorder to be ready for next attempt if user is still in "recognizing" mode
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = () => {
              console.log("[Client] MediaRecorder parado devido a 'no-speech', limpando chunks.");
              audioChunksRef.current = [];
              if (streamingState === "recognizing" && recognition) { // Double check state
                console.log("[Client] Reiniciando MediaRecorder após 'no-speech'.");
                startMediaRecorder();
              }
            }
            mediaRecorderRef.current.stop();
          } else if (streamingState === "recognizing" && recognition) {
            console.log("[Client] MediaRecorder não estava gravando, mas 'no-speech' ocorreu. Reiniciando MediaRecorder.");
            startMediaRecorder(); // Try to restart it
          }
        }
      } else if (event.error === 'audio-capture' || event.error === 'not-allowed') {
        // These are critical errors that likely require user intervention or mean recognition cannot continue.
        setStreamingState("error");
        stopRecognitionInternals(); // Stop everything
      } else if (streamingState === "recognizing") { 
        // For other errors like 'network', 'aborted', etc., try to stop gracefully and let user restart.
        // Don't immediately set to "error" state unless it's a persistent issue.
        // The 'onend' event will likely fire after some errors, which will transition state to 'idle'.
        console.log("[Client] SpeechRecognition error, onend será chamado para limpar.");
      }
    };

    recognition.onend = () => {
      console.log("[Client] SpeechRecognition finalizado (onend). Estado atual:", streamingState);
      // This onend can be triggered by speech inactivity, by calling .stop(), or after an error.
      // Only change state to idle if we are not already in 'stopping' (which will set to idle itself)
      // or if an error didn't already set it to a specific error state.
      if (streamingState === "recognizing") { 
        // If it ended unexpectedly (e.g., prolonged silence not caught by 'no-speech' or some other hiccup)
        setStreamingState("idle");
        setInterimTranscribedText("");
         if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = () => {
                console.log("[Client] MediaRecorder parado via recognition.onend (inesperado).");
                 // Stop media stream tracks
                const stream = mediaRecorderRef.current?.stream;
                if (stream) {
                    stream.getTracks().forEach(track => track.stop());
                }
                mediaRecorderRef.current = null;
            };
            mediaRecorderRef.current.stop();
        }
        console.log("[Client] Reconhecimento terminou inesperadamente, estado definido para idle.");
      }
      // `recognition` instance is nullified by `stopRecognition` or `stopRecognitionInternals` when appropriate.
    };
    
    console.log("[Client] Chamando recognition.start()...");
    try {
      recognition.start();
    } catch (e: any) {
      console.error("[Client] Erro ao chamar recognition.start():", e);
      setError(`Erro ao iniciar reconhecimento: ${e.message}`);
      setStreamingState("error");
      toast({ title: "Erro ao Iniciar", description: `Não foi possível iniciar o reconhecimento: ${e.message}`, variant: "destructive" });
      stopRecognitionInternals(); // Clean up
    }
  }, [sourceLanguage, targetLanguage, toast, streamingState, isSpeechRecognitionSupported, connectWebSocket, supportedMimeType, startMediaRecorder, stopRecognitionInternals]);


  const stopRecognition = useCallback(() => {
    console.log("[Client] Tentando parar reconhecimento (stopRecognition)...");
    if (streamingState !== "recognizing" && streamingState !== "stopping") {
        console.log("[Client] Não estava reconhecendo ou parando. Definindo para idle.");
        setStreamingState("idle"); // Ensure idle state if called when not active
        // Explicitly stop media tracks if mediaRecorderRef exists from a previous run
        if (mediaRecorderRef.current) {
             const stream = mediaRecorderRef.current.stream;
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                console.log("[Client] Trilhas de mídia paradas em stopRecognition (não estava reconhecendo).");
            }
            if(mediaRecorderRef.current.state === "recording") mediaRecorderRef.current.stop();
            mediaRecorderRef.current = null;
        }
        if(recognition) {
            recognition.abort(); // More forceful stop
            recognition = null;
        }
        return;
    }

    setStreamingState("stopping"); 
    stopRecognitionInternals();

    // recognition.onend (if not removed or if stop() internally calls it)
    // might race with this timeout. The timeout acts as a fallback.
    setTimeout(() => {
        if (streamingState === "stopping") { // Check if still in stopping state
            setStreamingState("idle");
            console.log("[Client] Streaming efetivamente parado após timeout, estado = idle.");
        }
    }, 500); 

  }, [streamingState, stopRecognitionInternals]);


  const handleToggleStreaming = () => {
    console.log("[Client] handleToggleStreaming chamado. Estado atual:", streamingState);
    if (streamingState === "recognizing") {
      stopRecognition();
    } else if (streamingState === "idle" || streamingState === "error") { 
      startRecognition();
    } else if (streamingState === "stopping"){
        console.log("[Client] Atualmente parando, aguarde.");
    }
  };
  

  const StreamButtonIcon = streamingState === "recognizing" ? MicOff : Mic;
  let streamButtonText = "Iniciar Transcrição";
  if (streamingState === "recognizing") streamButtonText = "Parar Transcrição";
  if (streamingState === "stopping") streamButtonText = "Parando...";
  
  const isButtonDisabled = streamingState === "stopping" || (!supportedMimeType && streamingState !== "error"); // Disable if stopping or if mimeType isn't supported (unless already in error state)
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
              {!supportedMimeType && streamingState !== "error" && (
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

    
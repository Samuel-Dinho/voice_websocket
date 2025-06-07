
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
let recognitionRestartTimer: NodeJS.Timeout | null = null;


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
      setIsTranslating(false);
      toast({ title: "Erro de Conexão", description: "Não foi possível conectar ao servidor WebSocket.", variant: "destructive" });
    };

    ws.current.onclose = (event) => {
      console.log(`[Client] WebSocket desconectado (client-side). Código: ${event.code}, Razão: "${event.reason}", Foi Limpo: ${event.wasClean}.`);
      if (streamingState === "recognizing" || streamingState === "stopping") {
         setStreamingState("idle");
      }
      if (ws.current && ws.current === event.target) {
        ws.current = null;
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
      console.warn('[Client] Nenhum MIME type suportado para MediaRecorder encontrado. A gravação de áudio pode não funcionar.');
      setError("Seu navegador não suporta gravação de áudio nos formatos necessários.");
    }

    return () => {
      if (recognition) {
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onstart = null;
        recognition.onend = null;
        recognition.abort();
        recognition = null;
      }
       if (recognitionRestartTimer) {
        clearTimeout(recognitionRestartTimer);
        recognitionRestartTimer = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.onstop = null;
        mediaRecorderRef.current.stop();
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


  const startMediaRecorder = useCallback(async () => {
    if (!supportedMimeType) {
      setError("Formato de áudio não suportado para gravação.");
      toast({ title: "Erro de Gravação", description: "Formato de áudio não suportado.", variant: "destructive" });
      return false;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        console.log("[Client] MediaRecorder já está gravando. Parando o anterior.");
        mediaRecorderRef.current.onstop = null; 
        try {
            mediaRecorderRef.current.stop();
        } catch (e) {
            console.warn("[Client] Erro ao parar MediaRecorder existente em startMediaRecorder:", e);
        }
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      audioChunksRef.current = [];
      console.log("[Client] audioChunksRef limpo no início de startMediaRecorder");

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
           console.log(`[Client] MediaRecorder.ondataavailable: chunk adicionado. Total chunks: ${audioChunksRef.current.length}`);
        }
      };
      
      mediaRecorderRef.current.onstop = () => {
        console.log("[Client] MediaRecorder parado (onstop genérico).");
        if (mediaRecorderRef.current) { 
             const s = mediaRecorderRef.current.stream;
             if(s) s.getTracks().forEach(t => t.stop());
             console.log("[Client] Trilhas de mídia paradas (onstop genérico).");
        }
      };

      mediaRecorderRef.current.start(1000); // Grava em chunks de 1s, dataavailable será acionado
      console.log("[Client] MediaRecorder iniciado com timeslice 1000ms.");
      return true;
    } catch (err) {
      console.error("[Client] Erro ao iniciar MediaRecorder:", err);
      setError("Falha ao acessar o microfone para gravação de áudio.");
      toast({ title: "Erro de Microfone", description: "Não foi possível iniciar a gravação de áudio.", variant: "destructive" });
      return false;
    }
  }, [supportedMimeType, toast]);


  const stopRecognitionInternals = useCallback(() => {
    console.log("[Client] Chamando stopRecognitionInternals.");
     if (recognitionRestartTimer) {
        clearTimeout(recognitionRestartTimer);
        recognitionRestartTimer = null;
    }
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onend = null; 
      try {
        recognition.stop(); // Use stop() para permitir que onend seja disparado se necessário, mas já setamos onend = null
        console.log("[Client] recognition.stop() chamado internamente.");
      } catch (e) {
         console.error("[Client] Erro ao chamar recognition.stop() internamente:", e);
      }
      recognition = null;
    }
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.onstop = () => { 
            console.log("[Client] MediaRecorder parado por stopRecognitionInternals.");
            const stream = mediaRecorderRef.current?.stream;
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                console.log("[Client] Trilhas de mídia paradas (interno via stopRecognitionInternals).");
            }
            mediaRecorderRef.current = null;
        };
        mediaRecorderRef.current.stop();
      } else { 
        const stream = mediaRecorderRef.current.stream;
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        mediaRecorderRef.current = null;
      }
    }
    audioChunksRef.current = [];
    setInterimTranscribedText("");
  }, []);

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

    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        console.log("[Client] WebSocket não conectado. Tentando reconectar antes de iniciar o reconhecimento...");
        connectWebSocket();
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
    
    if (recognitionRestartTimer) {
      clearTimeout(recognitionRestartTimer);
      recognitionRestartTimer = null;
    }

    const mediaRecorderStarted = await startMediaRecorder();
    if (!mediaRecorderStarted) {
      setStreamingState("error");
      stopRecognitionInternals();
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
      if (recognition && typeof recognition.stop === 'function') {
        recognition.onend = null; 
        recognition.abort(); 
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

    const sendDataAndPrepareNext = (text: string, isFinalSegment: boolean) => {
      if (!supportedMimeType) {
        console.warn("[Client] sendDataAndPrepareNext: MimeType não disponível.");
        if (isFinalSegment && streamingState === "recognizing" && recognition && typeof recognition.start === 'function') {
           console.log("[Client] sendDataAndPrepareNext: Tentando reiniciar recognition mesmo sem áudio para enviar.");
           recognition.start();
        }
        return;
      }
    
      const audioBlobToSend = new Blob(audioChunksRef.current, { type: supportedMimeType });
      const currentChunks = [...audioChunksRef.current]; // Copia os chunks para este envio específico
      audioChunksRef.current = []; // Limpa chunks globais *APÓS* copiar para o blob específico deste envio
      console.log(`[Client] sendDataAndPrepareNext: audioChunksRef limpo após criar blob. ${currentChunks.length} chunks foram usados para o blob.`);

      if (audioBlobToSend.size > 0 && ws.current && ws.current.readyState === WebSocket.OPEN) {
        const reader = new FileReader();
        reader.onloadend = () => {
          const audioDataUri = reader.result as string;
          console.log(`[Client] Enviando texto "${text}" e áudio (${(audioBlobToSend.size / 1024).toFixed(2)} KB).`);
          setIsTranslating(true);
          ws.current.send(JSON.stringify({
            action: "process_speech",
            transcribedText: text,
            sourceLanguage: sourceLanguage,
            targetLanguage: targetLanguage,
            audioDataUri: audioDataUri
          }));
        };
        reader.readAsDataURL(audioBlobToSend);
      } else {
        if (audioBlobToSend.size === 0) console.warn(`[Client] Blob de áudio vazio para "${text}". Chunks usados: ${currentChunks.length}`);
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN) console.warn("[Client] WebSocket não aberto ao tentar enviar.");
      }
  
      if (isFinalSegment && streamingState === "recognizing" && recognition && typeof recognition.start === 'function') {
        console.log("[Client] Segmento final processado. Reiniciando SpeechRecognition.");
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "recording") {
           console.log("[Client] MediaRecorder não estava gravando. Iniciando para o próximo segmento.");
           startMediaRecorder(); 
        }
        recognition.start();
      } else if (isFinalSegment && streamingState === "recognizing" && !recognition) {
        console.warn("[Client] Recognition é nulo no final do segmento, mas o streaming está ativo. Tentando reiniciar completamente.");
        startRecognition();
      }
    };


    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (recognitionRestartTimer) {
        clearTimeout(recognitionRestartTimer);
        recognitionRestartTimer = null;
        console.log("[Client] recognitionRestartTimer limpo por onresult.");
      }
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
         console.log(`[Client] Texto final recebido: "${newFinalText}"`);
         setTranscribedText(prev => (prev ? prev.trim() + " " : "") + newFinalText);
         setInterimTranscribedText("");
         sendDataAndPrepareNext(newFinalText, true);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (recognitionRestartTimer) {
        clearTimeout(recognitionRestartTimer);
        recognitionRestartTimer = null;
      }
      console.error("[Client] Erro no SpeechRecognition:", event.error, event.message);
      let errMessage = `Erro no reconhecimento: ${event.error}`;
      if (event.error === 'network') errMessage = "Erro de rede durante o reconhecimento.";
      else if (event.error === 'no-speech') {
        errMessage = "Nenhuma fala detectada.";
        if (streamingState === "recognizing" && recognition) {
            console.log("[Client] Erro 'no-speech'. Tentando reiniciar MediaRecorder e SpeechRecognition.");
            audioChunksRef.current = []; // Limpa chunks de silêncio
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                mediaRecorderRef.current.onstop = () => {
                    if (mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                    if (streamingState === "recognizing") {
                       startMediaRecorder().then(() => {
                          if (recognition && typeof recognition.start === 'function') recognition.start();
                       });
                    }
                }
                mediaRecorderRef.current.stop();
            } else if (streamingState === "recognizing") { // MR não estava gravando, mas precisamos reiniciar
                startMediaRecorder().then(() => {
                  if (recognition && typeof recognition.start === 'function') recognition.start();
                });
            }
        }
      } else if (event.error === 'audio-capture') errMessage = "Falha na captura de áudio. Verifique permissões do microfone.";
      else if (event.error === 'not-allowed') errMessage = "Permissão do microfone negada.";
      else if (event.error === 'language-not-supported') errMessage = `Idioma '${recognition?.lang}' não suportado pelo motor de reconhecimento.`;
      else if (event.message) errMessage += `. Detalhes: ${event.message}`;

      setError(errMessage);
      if (event.error !== 'no-speech') { 
        toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
      }

      if (event.error === 'audio-capture' || event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setStreamingState("error");
        stopRecognitionInternals();
      }
    };

    recognition.onend = () => {
      console.log("[Client] SpeechRecognition.onend disparado. Estado atual:", streamingState);
      if (recognitionRestartTimer) { 
        clearTimeout(recognitionRestartTimer);
        recognitionRestartTimer = null;
      }
      if (streamingState === "recognizing") {
        console.log("[Client] SpeechRecognition.onend: Reconhecimento terminou, mas streamingState é 'recognizing'. Tentando reiniciar em 250ms se não houver resultado pendente.");
        recognitionRestartTimer = setTimeout(() => {
          if (streamingState === "recognizing") {
            if (recognition && typeof recognition.start === 'function') {
              console.log("[Client] Reiniciando recognition após onend e timeout.");
              recognition.start();
            } else if (!recognition) {
              console.log("[Client] Recognition é nulo após onend e timeout, mas streamingState é recognizing. Tentando startRecognition() completo.");
              startRecognition(); 
            }
          }
        }, 250);
      } else if (streamingState === "stopping") {
        console.log("[Client] SpeechRecognition.onend: Transcrição estava parando, definindo estado para idle.");
        setStreamingState("idle");
      }
    };

    console.log("[Client] Chamando recognition.start()...");
    try {
       if (recognitionRestartTimer) { // Limpa qualquer timer de reinício pendente
        clearTimeout(recognitionRestartTimer);
        recognitionRestartTimer = null;
      }
      recognition.start();
    } catch (e: any) {
      console.error("[Client] Erro ao chamar recognition.start():", e);
      setError(`Erro ao iniciar reconhecimento: ${e.message}`);
      setStreamingState("error");
      toast({ title: "Erro ao Iniciar", description: `Não foi possível iniciar o reconhecimento: ${e.message}`, variant: "destructive" });
      stopRecognitionInternals();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceLanguage, targetLanguage, toast, streamingState, isSpeechRecognitionSupported, connectWebSocket, supportedMimeType, startMediaRecorder, stopRecognitionInternals, setIsTranslating, setError, setTranscribedText, setInterimTranscribedText, setTranslatedText]);


  const stopRecognition = useCallback(() => {
    console.log("[Client] Tentando parar reconhecimento (stopRecognition)...");
    if (streamingState !== "recognizing" && streamingState !== "stopping") {
        console.log("[Client] Não estava reconhecendo ou parando. Definindo para idle.");
        setStreamingState("idle");
        stopRecognitionInternals(); 
        return;
    }

    setStreamingState("stopping"); 
    stopRecognitionInternals(); 

    setTimeout(() => {
        if (streamingState === "stopping") {
            console.log("[Client] Timeout após stopRecognition: garantindo estado idle.");
            setStreamingState("idle");
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

  const isButtonDisabled = streamingState === "stopping" || (!supportedMimeType && streamingState !== "error");
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

    

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
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
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
        console.log("[Client] MediaRecorder já está gravando. Tentando parar o anterior antes de reiniciar.");
        mediaRecorderRef.current.onstop = null; // Remove o onstop antigo para evitar conflitos
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
        }
      };

      // Definindo um onstop genérico que apenas libera as tracks se não estivermos mais reconhecendo.
      // O onstop específico para processamento de segmento será definido em recognition.onresult.
      mediaRecorderRef.current.onstop = () => {
        console.log("[Client] MediaRecorder parado (onstop genérico definido em startMediaRecorder).");
        if (streamingState !== "recognizing" && mediaRecorderRef.current) {
            const s = mediaRecorderRef.current.stream;
            if(s) s.getTracks().forEach(t => t.stop());
            console.log("[Client] Trilhas de mídia paradas (onstop genérico).");
        }
      };

      mediaRecorderRef.current.start();
      console.log("[Client] MediaRecorder iniciado.");
      return true;
    } catch (err) {
      console.error("[Client] Erro ao iniciar MediaRecorder:", err);
      setError("Falha ao acessar o microfone para gravação de áudio.");
      toast({ title: "Erro de Microfone", description: "Não foi possível iniciar a gravação de áudio.", variant: "destructive" });
      return false;
    }
  }, [supportedMimeType, toast, streamingState]);


  const stopRecognitionInternals = useCallback(() => {
    console.log("[Client] Chamando stopRecognitionInternals. Estado atual:", streamingState);
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onend = null; // Importante: remove o onend para evitar chamadas inesperadas durante a parada.
      try {
        recognition.stop();
        console.log("[Client] recognition.stop() chamado internamente.");
      } catch (e) {
         console.error("[Client] Erro ao chamar recognition.stop() internamente:", e);
      }
      recognition = null;
    }
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.onstop = () => { // onstop para limpeza ao parar explicitamente
            console.log("[Client] MediaRecorder parado por stopRecognitionInternals.");
            const stream = mediaRecorderRef.current?.stream;
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                console.log("[Client] Trilhas de mídia paradas (interno via stopRecognitionInternals).");
            }
            mediaRecorderRef.current = null;
        };
        mediaRecorderRef.current.stop();
      } else { // Se não estiver gravando, mas a referência existir
        const stream = mediaRecorderRef.current.stream;
        if (stream) {
            stream.getTracks().forEach(track => track.stop());
        }
        mediaRecorderRef.current = null;
      }
    }
    audioChunksRef.current = [];
    setInterimTranscribedText("");
  }, [streamingState]);

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
      if (recognition) {
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
         console.log(`[Client] Texto final recebido: "${newFinalText}"`);
         setTranscribedText(prev => (prev ? prev.trim() + " " : "") + newFinalText);
         setInterimTranscribedText("");

         if (mediaRecorderRef.current) {
           // Define o manipulador onstop que fará o envio e o reinício.
           mediaRecorderRef.current.onstop = () => {
             console.log(`[Client] MediaRecorder.onstop acionado para: "${newFinalText}"`);
             const audioBlob = supportedMimeType && audioChunksRef.current.length > 0
                               ? new Blob(audioChunksRef.current, { type: supportedMimeType })
                               : null;

             if (audioBlob && ws.current && ws.current.readyState === WebSocket.OPEN) {
               const reader = new FileReader();
               reader.onloadend = () => {
                 const audioDataUri = reader.result as string;
                 console.log(`[Client] Enviando texto final "${newFinalText}" e áudio.`);
                 setIsTranslating(true);
                 ws.current.send(JSON.stringify({
                   action: "process_speech",
                   transcribedText: newFinalText,
                   sourceLanguage: sourceLanguage,
                   targetLanguage: targetLanguage,
                   audioDataUri: audioDataUri
                 }));
               };
               reader.readAsDataURL(audioBlob);
             } else {
               if (!audioBlob) console.warn(`[Client] Sem blob de áudio no onstop para "${newFinalText}". Chunks: ${audioChunksRef.current.length}`);
               if (!ws.current || ws.current.readyState !== WebSocket.OPEN) console.warn("[Client] WebSocket não aberto no onstop.");
             }

             console.log("[Client] Limpando audioChunksRef após processamento/envio em onstop.");
             audioChunksRef.current = [];

             if (streamingState === "recognizing" && recognition) {
               console.log("[Client] Reiniciando MediaRecorder a partir do onstop. StreamingState:", streamingState);
               startMediaRecorder();
             } else {
               console.log("[Client] Não reiniciando MediaRecorder do onstop. StreamingState:", streamingState, "Recognition exists:", !!recognition);
               const stream = mediaRecorderRef.current?.stream;
               if (stream) {
                   stream.getTracks().forEach(track => track.stop());
               }
             }
             // Limpa este onstop específico para evitar chamadas repetidas se algo mais chamar stop()
             if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
           }; // Fim da definição de onstop

           if (mediaRecorderRef.current.state === "recording") {
             console.log(`[Client] Parando MediaRecorder para processar: "${newFinalText}"`);
             mediaRecorderRef.current.stop();
           } else {
             console.warn(`[Client] MediaRecorder não estava gravando quando onresult final chegou para "${newFinalText}". Estado: ${mediaRecorderRef.current.state}. Tentando processar com onstop manualmente.`);
             // Se não estava gravando, o onstop não será acionado por stop().
             // Chamamos a função onstop definida acima manualmente.
             if (mediaRecorderRef.current.onstop) {
                mediaRecorderRef.current.onstop();
             } else {
                // Fallback muito improvável, mas por segurança
                console.error("[Client] MediaRecorder.onstop não estava definido para chamada manual.");
                audioChunksRef.current = [];
                if (streamingState === "recognizing" && recognition) {
                    console.log("[Client] Reiniciando MediaRecorder (fallback em onresult, mediarecorder parado).");
                    startMediaRecorder();
                }
             }
           }
         } else {
           console.error("[Client] mediaRecorderRef.current é nulo em onresult. Não é possível processar áudio.");
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
        if (streamingState === "recognizing" && mediaRecorderRef.current) {
            // Se não houve fala, podemos apenas limpar os chunks e reiniciar o media recorder
            // para a próxima tentativa, não há áudio para enviar.
            console.log("[Client] Erro 'no-speech'. Limpando chunks e preparando MediaRecorder.");
            audioChunksRef.current = [];
            // Não precisamos parar e reiniciar o MediaRecorder se ele já estiver gravando e 'no-speech'
            // significar que a API de fala simplesmente não detectou nada. Mas se foi parado, reinicie.
            if (mediaRecorderRef.current.state !== "recording") {
                startMediaRecorder();
            }
        }
      } else if (event.error === 'audio-capture' || event.error === 'not-allowed') {
        setStreamingState("error");
        stopRecognitionInternals();
      } else if (streamingState === "recognizing") {
        console.log("[Client] Erro no SpeechRecognition, onend pode ser chamado para limpar.");
      }
    };

    recognition.onend = () => {
      console.log("[Client] SpeechRecognition.onend disparado. Estado atual:", streamingState);
      // Apenas mude o estado para idle se estivermos explicitamente no processo de parada.
      // Se o reconhecimento terminar por conta própria (ex: silêncio),
      // a lógica em onresult (via onstop do MediaRecorder) ou onerror (no-speech)
      // deve ter tratado o reinício ou a parada do MediaRecorder.
      if (streamingState === "stopping") {
        console.log("[Client] SpeechRecognition.onend: Transcrição estava parando, definindo estado para idle.");
        setStreamingState("idle");
        setInterimTranscribedText("");
        // MediaRecorder e tracks já devem ter sido parados por stopRecognitionInternals.
      } else if (streamingState === "recognizing") {
        console.log("[Client] SpeechRecognition.onend: Reconhecimento terminou por si só. Não alterando estado de streaming aqui.");
        // Não fazer nada aqui, pois onresult ou onerror devem ter lidado com o fluxo.
        // Se um onresult com isFinal=true foi o último, o onstop do MediaRecorder cuidará do reinício.
        // Se foi um erro como no-speech, onerror cuidou.
        // Se simplesmente parou sem resultado final, o usuário pode precisar falar novamente.
        // O MediaRecorder deve continuar gravando ou ter sido reiniciado pelo onstop.
      }
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
  }, [sourceLanguage, targetLanguage, toast, streamingState, isSpeechRecognitionSupported, connectWebSocket, supportedMimeType, startMediaRecorder, stopRecognitionInternals, setIsTranslating, setError, setTranscribedText, setInterimTranscribedText]);


  const stopRecognition = useCallback(() => {
    console.log("[Client] Tentando parar reconhecimento (stopRecognition)...");
    if (streamingState !== "recognizing" && streamingState !== "stopping") {
        console.log("[Client] Não estava reconhecendo ou parando. Definindo para idle.");
        setStreamingState("idle");
        if (recognition) { // Limpa a instância de recognition se existir
            recognition.abort();
            recognition = null;
        }
        if (mediaRecorderRef.current) { // Limpa MediaRecorder
             const stream = mediaRecorderRef.current.stream;
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                console.log("[Client] Trilhas de mídia paradas em stopRecognition (não estava reconhecendo).");
            }
            if(mediaRecorderRef.current.state === "recording") {
                mediaRecorderRef.current.onstop = null; // evita onstop de processamento
                mediaRecorderRef.current.stop();
            }
            mediaRecorderRef.current = null;
        }
        return;
    }

    setStreamingState("stopping");
    stopRecognitionInternals(); // stopRecognitionInternals já lida com MediaRecorder e recognition.

    // O onend do recognition, se streamingState for "stopping", mudará para "idle".
    // Adicionar um timeout aqui pode ser redundante ou causar conflitos se o onend demorar.
    // Vamos confiar que stopRecognitionInternals e o onend do recognition farão a transição para idle.
    // Se após stopRecognitionInternals, recognition.onend for chamado, ele moverá para idle.
    // Se recognition já era null, precisamos garantir a ida para idle.
    setTimeout(() => {
        if (streamingState === "stopping") {
            console.log("[Client] Timeout após stopRecognition: garantindo estado idle.");
            setStreamingState("idle");
        }
    }, 500); // Pequeno delay para garantir que os processos de parada tenham tempo

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

    

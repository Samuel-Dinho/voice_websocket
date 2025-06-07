
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Mic, MicOff, Loader2, AlertTriangle, LanguagesIcon, PlaySquare } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { supportedLanguages } from "@/lib/languages";
import { useToast } from "@/hooks/use-toast";
import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Separator } from "@/components/ui/separator";
import Link from "next/link";

type StreamingState = "idle" | "recognizing" | "error" | "stopping";

let recognition: SpeechRecognition | null = null;
const END_OF_SPEECH_TIMEOUT_MS = 2500; 

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

  const endOfSpeechTimerRef = useRef<NodeJS.Timeout | null>(null);
  const accumulatedInterimRef = useRef<string>("");


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
       if (streamingState !== 'error') setStreamingState("error");
    }

    return () => {
      stopRecognitionInternals(true); 
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        console.log("[Client] Fechando WebSocket ao desmontar o componente...");
        ws.current.close(1000, "Component unmounting");
      }
      ws.current = null; 
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); 

  const isSpeechRecognitionSupported = useCallback(() => {
    return typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  }, []);

   useEffect(() => {
    if (!isSpeechRecognitionSupported()) {
      setError("Reconhecimento de fala não é suportado pelo seu navegador.");
      if (streamingState !== 'error') setStreamingState("error");
      toast({
        title: "Navegador Incompatível",
        description: "Seu navegador não suporta a API Web Speech.",
        variant: "destructive",
      });
    }
  }, [isSpeechRecognitionSupported, toast, streamingState]);


  const startMediaRecorder = useCallback(async (): Promise<boolean> => {
    if (!supportedMimeType) {
      setError("Formato de áudio não suportado para gravação.");
      toast({ title: "Erro de Gravação", description: "Formato de áudio não suportado.", variant: "destructive" });
      return false;
    }
    
    audioChunksRef.current = [];
    console.log("[Client] audioChunksRef limpo no início de startMediaRecorder.");

    if (mediaRecorderRef.current) {
        if (mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = null; 
            mediaRecorderRef.current.ondataavailable = null;
            try {
                mediaRecorderRef.current.stop();
            } catch (e) {
                console.warn("[Client] Erro ao parar MediaRecorder existente em startMediaRecorder:", e);
            }
        }
        if (mediaRecorderRef.current.stream) {
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
        mediaRecorderRef.current = null; 
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      console.log("[Client] Novo MediaRecorder criado.");

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
           console.log(`[Client] MediaRecorder.ondataavailable: chunk adicionado. Total chunks: ${audioChunksRef.current.length}, tamanho do chunk: ${event.data.size}`);
        }
      };
      
      mediaRecorderRef.current.onstop = () => { 
        console.log("[Client] MediaRecorder parado (onstop genérico). Estado MR:", mediaRecorderRef.current?.state);
        if (mediaRecorderRef.current && mediaRecorderRef.current.stream) {
             mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
        }
      };

      mediaRecorderRef.current.start(1000); 
      console.log("[Client] MediaRecorder iniciado com timeslice 1000ms.");
      return true;
    } catch (err) {
      console.error("[Client] Erro ao iniciar MediaRecorder:", err);
      setError("Falha ao acessar o microfone para gravação.");
      toast({ title: "Erro de Microfone", description: "Não foi possível iniciar a gravação de áudio.", variant: "destructive" });
      setStreamingState("error");
      return false;
    }
  }, [supportedMimeType, toast]);


  const sendDataToServer = useCallback(async (text: string) => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
      console.warn("[Client] WebSocket não está aberto. Não é possível enviar dados.");
      setError("Conexão perdida. Não foi possível enviar dados.");
      setIsTranslating(false);
      return;
    }
    if (!supportedMimeType) {
      console.warn("[Client] MimeType não suportado. Não é possível enviar áudio.");
      setIsTranslating(false);
      return;
    }

    let blobToActuallySend: Blob | null = null;
    if (audioChunksRef.current.length > 0) {
        blobToActuallySend = new Blob(audioChunksRef.current, { type: supportedMimeType });
        console.log(`[Client] sendDataToServer: Criado Blob de ${audioChunksRef.current.length} chunks, tamanho: ${blobToActuallySend.size} bytes para o texto "${text.substring(0,30)}..."`);
    } else {
        console.warn(`[Client] sendDataToServer: Nenhum chunk de áudio para criar Blob para o texto: "${text.substring(0,30)}..."`);
    }
    
    audioChunksRef.current = []; // Limpa os chunks APÓS criar o blob para envio
    console.log("[Client] audioChunksRef limpo em sendDataToServer (após criar blob).");

    if (text.trim() && blobToActuallySend && blobToActuallySend.size > 0) {
      setIsTranslating(true);
      const reader = new FileReader();
      reader.onloadend = async () => {
        const audioDataUri = reader.result as string;
        console.log(`[Client] Enviando texto: "${text.substring(0,30)}..." e áudio (${(blobToActuallySend!.size / 1024).toFixed(2)} KB).`);
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({
            action: "process_speech",
            transcribedText: text,
            sourceLanguage: sourceLanguage,
            targetLanguage: targetLanguage,
            audioDataUri: audioDataUri
          }));
        } else {
          console.warn("[Client] WebSocket fechou antes do envio do áudio.");
          setIsTranslating(false); 
        }
      };
      reader.onerror = async () => {
        console.error("[Client] Erro ao ler Blob como Data URI.");
        setIsTranslating(false);
      };
      reader.readAsDataURL(blobToActuallySend);
    } else {
      console.warn(`[Client] Não enviando (sendDataToServer): Texto vazio ou Blob de áudio nulo/vazio (tamanho: ${blobToActuallySend?.size ?? 0}) para texto: "${text.substring(0,30)}..."`);
      if (!text.trim()) console.log("[Client] Motivo: Texto vazio.");
      if (!blobToActuallySend || blobToActuallySend.size === 0) console.log("[Client] Motivo: Blob de áudio nulo ou vazio.");
      setIsTranslating(false); 
    }
  }, [supportedMimeType, sourceLanguage, targetLanguage]); 


  const stopRecognitionInternals = useCallback((isUnmounting = false) => {
    console.log("[Client] Chamando stopRecognitionInternals.", { isUnmounting });
    if (endOfSpeechTimerRef.current) {
      clearTimeout(endOfSpeechTimerRef.current);
      endOfSpeechTimerRef.current = null;
    }
    
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onend = null; 
      try {
        console.log("[Client] recognition.abort() chamado em stopRecognitionInternals.");
        recognition.abort(); 
      } catch (e) {
         console.warn("[Client] Erro ao chamar recognition.abort():", e);
      }
      recognition = null;
    }

    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.onstop = null; 
      mediaRecorderRef.current.ondataavailable = null;
      if (mediaRecorderRef.current.state === "recording") {
        try { 
            console.log("[Client] MediaRecorder.stop() chamado em stopRecognitionInternals (estava gravando).");
            mediaRecorderRef.current.stop(); 
        } catch (e) { console.warn("Erro ao parar MR em stopRecInternals (gravando)", e);}
      }
       if(mediaRecorderRef.current.stream){ 
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
            console.log("[Client] Trilhas de stream do MediaRecorder paradas em stopRecognitionInternals.");
        }
      mediaRecorderRef.current = null;
    }
    
    audioChunksRef.current = [];
    console.log("[Client] audioChunksRef limpo em stopRecognitionInternals.");
    accumulatedInterimRef.current = ""; 
    setInterimTranscribedText("");    
    if (!isUnmounting && streamingState !== "idle") { 
        setStreamingState("idle");
    }
  }, [streamingState]); 


  const startRecognition = useCallback(async () => {
    console.log("[Client] Tentando iniciar/reiniciar reconhecimento (startRecognition). Estado atual:", streamingState, "Idioma Fonte:", sourceLanguage);
    if (!isSpeechRecognitionSupported()) { setError("Reconhecimento não suportado"); return; }
    if (!supportedMimeType) { setError("Formato de áudio não suportado"); return; }

    // Limpa estados antes de (re)iniciar
    setTranscribedText("");
    setInterimTranscribedText("");
    setTranslatedText(""); 
    accumulatedInterimRef.current = "";
    if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        console.log("[Client] WebSocket não conectado. Tentando reconectar...");
        connectWebSocket(); 
        await new Promise(resolve => setTimeout(resolve, 500)); 
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
            setError("Falha ao conectar ao WebSocket.");
            toast({ title: "Erro de Conexão", description: "Servidor WebSocket indisponível.", variant: "destructive" });
            setStreamingState("error"); 
            return;
        }
    }

    setStreamingState("recognizing");
    setError(null);

    const mediaRecorderStarted = await startMediaRecorder();
    if (!mediaRecorderStarted) {
      setStreamingState("error"); 
      stopRecognitionInternals(); 
      return;
    }

    toast({ title: "Microfone Ativado", description: "Iniciando reconhecimento e gravação..." });

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) { setError("API SpeechRecognition não encontrada"); stopRecognitionInternals(); return; }

    if (recognition) { 
        console.warn("[Client] Instância de Recognition pré-existente encontrada em startRecognition. Abortando-a.");
        recognition.abort();      
        recognition = null;
    }
    try {
      recognition = new SpeechRecognitionAPI();
    } catch (e: any) { setError(`Erro ao criar SpeechRecognition: ${e.message}`); stopRecognitionInternals(); return; }

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
    console.log(`[Client] Instância SpeechRecognition criada/recriada. Idioma: ${recognition.lang}`);

    recognition.onresult = async (event: SpeechRecognitionEvent) => {
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

      let finalTranscriptForThisSegment = "";
      let interimTranscriptForCurrentEvent = "";

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcriptPart = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscriptForThisSegment += transcriptPart; 
        } else {
          interimTranscriptForCurrentEvent += transcriptPart;
        }
      }
      
      finalTranscriptForThisSegment = finalTranscriptForThisSegment.trim();
      
      if (finalTranscriptForThisSegment) {
        console.log(`[Client] Texto final de segmento recebido: "${finalTranscriptForThisSegment}"`);
        setTranscribedText(prev => (prev ? prev.trim() + " " : "") + finalTranscriptForThisSegment);
        accumulatedInterimRef.current = ""; 
        setInterimTranscribedText("");

        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
                console.log(`[Client] MediaRecorder.onstop (para final_transcript): "${finalTranscriptForThisSegment}"`);
                await sendDataToServer(finalTranscriptForThisSegment); 
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                if (recognition) recognition.stop(); // Força onend para o ciclo de reinício
            };
            try { mediaRecorderRef.current.stop(); } catch(e) { console.warn("Error stopping MR for final transcript:", e); await sendDataToServer(finalTranscriptForThisSegment); if(recognition) recognition.stop();}
        } else { 
            console.warn(`[Client] MediaRecorder não gravando ou nulo para final_transcript: "${finalTranscriptForThisSegment}". Estado: ${mediaRecorderRef.current?.state}. Tentando enviar e parar SR.`);
            await sendDataToServer(finalTranscriptForThisSegment);
            if (recognition) recognition.stop(); // Força onend
        }
      } else if (interimTranscriptForCurrentEvent) {
        accumulatedInterimRef.current = interimTranscriptForCurrentEvent;
        setInterimTranscribedText(accumulatedInterimRef.current);

        endOfSpeechTimerRef.current = setTimeout(async () => {
          const interimToProcess = accumulatedInterimRef.current.trim();
          if (interimToProcess && streamingState === "recognizing") { 
            console.log(`[Client] Timeout de fim de fala. Processando interino como final: "${interimToProcess}"`);
            setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcess);
            accumulatedInterimRef.current = "";
            setInterimTranscribedText("");

            if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                mediaRecorderRef.current.onstop = async () => {
                    console.log(`[Client] MediaRecorder.onstop (para timeout interino): "${interimToProcess}"`);
                    await sendDataToServer(interimToProcess);
                    if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null; 
                    if (recognition) recognition.stop(); // Força onend
                };
                try { mediaRecorderRef.current.stop(); } catch(e) { console.warn("Error stopping MR for interim timeout:", e); await sendDataToServer(interimToProcess); if(recognition) recognition.stop(); }
            } else { 
                console.warn(`[Client] MediaRecorder não gravando ou nulo para timeout interino: "${interimToProcess}". Tentando enviar e parar SR.`);
                await sendDataToServer(interimToProcess);
                if (recognition) recognition.stop(); // Força onend
            }
          }
        }, END_OF_SPEECH_TIMEOUT_MS);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);
      console.error("[Client] Erro no SpeechRecognition:", event.error, event.message);
      let errMessage = `Erro no reconhecimento: ${event.error}`;
      
      const interimOnError = accumulatedInterimRef.current.trim();
      if (interimOnError && (event.error === 'no-speech' || event.error === 'network' || event.error === 'audio-capture')) {
          console.log(`[Client] Erro SR '${event.error}', com interino: "${interimOnError}". Processando como final e parando SR.`);
          setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimOnError);
          accumulatedInterimRef.current = "";
          setInterimTranscribedText("");
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
               await sendDataToServer(interimOnError); 
               if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
               if (recognition) recognition.stop(); // Força onend
            };
            try { mediaRecorderRef.current.stop(); } catch(e) { console.warn("Error stopping MR on error with interim:", e); (async ()=>{ await sendDataToServer(interimOnError); if(recognition)recognition.stop(); })(); }
          } else {
            (async ()=>{ await sendDataToServer(interimOnError); if(recognition) recognition.stop(); })();
          }
      }
      
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        errMessage = "Permissão do microfone negada ou serviço não permitido.";
        setStreamingState("error"); 
        stopRecognitionInternals(); 
      } else if (event.error === 'language-not-supported') {
        errMessage = `Idioma '${recognition?.lang}' não suportado.`;
        setStreamingState("error"); 
        stopRecognitionInternals(); 
      } else if (event.error === 'aborted') {
        console.log("[Client] SpeechRecognition aborted, provavelmente intencional.");
        // Não precisa fazer nada aqui, onend vai lidar se o estado for 'stopping' ou 'idle'
      } else if (event.error !== 'no-speech' || !interimOnError) {
         // Para outros erros, tentaremos que onend reinicie se apropriado
         if(recognition) recognition.stop(); // Força onend
      }
      
      setError(errMessage);
      if (event.error !== 'no-speech' || !interimOnError) { 
        if(event.error !== 'aborted') {
            toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
        }
      }
    };

    recognition.onend = async () => {
      console.log("[Client] SpeechRecognition.onend disparado. Estado atual:", streamingState);
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

      if (streamingState === "recognizing") {
        console.log("[Client] SR.onend: streamingState é 'recognizing'. Reiniciando ciclo de reconhecimento e gravação...");
        // A função startRecognition reinicia tanto o MediaRecorder quanto o SpeechRecognition.
        // É importante que startRecognition limpe o estado anterior do recognition.
        await startRecognition(); 
      } else if (streamingState === "stopping") {
        console.log("[Client] SpeechRecognition.onend: Transcrição estava parando. Limpando.");
        stopRecognitionInternals(); 
      } else { 
        console.log("[Client] SR.onend: streamingState é", streamingState, "- não reiniciando.");
        if (streamingState === 'error') {
            stopRecognitionInternals();
        }
      }
    };

    console.log("[Client] Chamando recognition.start()...");
    try {
      recognition.start();
    } catch (e: any) {
      console.error("[Client] Erro ao chamar recognition.start():", e);
      setError(`Erro ao iniciar reconhecimento: ${e.message}`);
      setStreamingState("error");
      stopRecognitionInternals();
    }
  }, [isSpeechRecognitionSupported, supportedMimeType, streamingState, sourceLanguage, sendDataToServer, stopRecognitionInternals, connectWebSocket, toast, startMediaRecorder]);


  const stopRecognition = useCallback(async () => {
    console.log("[Client] Tentando parar reconhecimento (stopRecognition)... Estado atual:", streamingState);
    if (streamingState === "idle" || streamingState === "stopping") {
        console.log("[Client] Já está idle ou parando. Chamando stopRecognitionInternals para garantir limpeza.");
        stopRecognitionInternals(); 
        setStreamingState("idle"); 
        return;
    }

    setStreamingState("stopping"); 

    if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

    const interimToProcessOnStop = accumulatedInterimRef.current.trim();
    if (interimToProcessOnStop) {
        console.log(`[Client] Parando. Processando interino acumulado final: "${interimToProcessOnStop}"`);
        setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcessOnStop);
        
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
                console.log(`[Client] MR.onstop durante stopRecognition para interino: "${interimToProcessOnStop}"`);
                await sendDataToServer(interimToProcessOnStop); 
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                // SR.stop() abaixo vai acionar onend, que não reiniciará por causa do estado "stopping"
            };
            try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Error stopping MR during stopRecognition for interim", e); await sendDataToServer(interimToProcessOnStop); }
        } else {
           await sendDataToServer(interimToProcessOnStop);
        }
    } else {
         if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = () => { 
                console.log(`[Client] MR.onstop durante stopRecognition (sem interino).`);
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
            };
            try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Error stopping MR during stop (no interim)", e); }
        }
    }
    accumulatedInterimRef.current = ""; 
    setInterimTranscribedText("");

    if (recognition) {
        console.log("[Client] stopRecognition: Chamando recognition.stop() para finalizar a sessão SR.");
        recognition.stop(); // Isso acionará onend, que verá 'stopping' e limpará.
    } else {
        console.log("[Client] stopRecognition: recognition é nulo. Chamando stopRecognitionInternals.");
        stopRecognitionInternals();
    }
  }, [streamingState, stopRecognitionInternals, sendDataToServer, accumulatedInterimRef]);


  const handleToggleStreaming = () => {
    console.log("[Client] handleToggleStreaming chamado. Estado atual:", streamingState);
    if (streamingState === "recognizing") {
      stopRecognition();
    } else if (streamingState === "idle" || streamingState === "error") {
      if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        connectWebSocket(); 
        setTimeout(() => { // Dá um tempo para a conexão
            startRecognition();
        }, 500);
      } else {
        startRecognition();
      }
    } else if (streamingState === "stopping"){
        console.log("[Client] Atualmente parando, aguarde.");
    }
  };


  const StreamButtonIcon = streamingState === "recognizing" ? MicOff : Mic;
  let streamButtonText = "Iniciar Transcrição";
  if (streamingState === "recognizing") streamButtonText = "Parar Transcrição";
  if (streamingState === "stopping") streamButtonText = "Parando...";

  const isButtonDisabled = streamingState === "stopping" || (!supportedMimeType && streamingState !== "error" && streamingState !== "idle");
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
           <Link href="/listener" className="text-sm text-primary hover:underline flex items-center justify-center gap-1">
                <PlaySquare size={16} />
                Ir para a Página do Ouvinte
            </Link>
        </div>
      </header>

      <main className="w-full max-w-3xl">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              Transcrição e Tradução
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
              {!supportedMimeType && streamingState !== "error" && streamingState !== "idle" && (
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
                  placeholder={streamingState === "recognizing" ? "Ouvindo..." : "A transcrição aparecerá aqui..."}
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
        <p className="mt-1">Transcrição local via API Web Speech. Gravação local via MediaRecorder. Tradução via servidor Genkit.</p>
      </footer>
    </div>
  );
}

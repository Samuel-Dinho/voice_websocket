
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

let recognition: any | null = null;
const END_OF_SPEECH_TIMEOUT_MS = 2500;


export default function LinguaVoxPage() {
  const ws = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const { toast } = useToast();

  const [sourceLanguage, setSourceLanguage] = useState<string>("pt");
  const [targetLanguage, setTargetLanguage] = useState<string>("en");
  const [streamingState, setStreamingState] = useState<StreamingState>("idle");
  const streamingStateRef = useRef<StreamingState>(streamingState);

  useEffect(() => {
    streamingStateRef.current = streamingState;
  }, [streamingState]);

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
      if(streamingStateRef.current !== "error") setStreamingState("error");
      toast({ title: "Erro de Conexão", description: "Não foi possível conectar ao servidor WebSocket.", variant: "destructive" });
    };

    ws.current.onclose = (event) => {
      console.log(`[Client] WebSocket desconectado (client-side). Código: ${event.code}, Razão: "${event.reason}", Foi Limpo: ${event.wasClean}.`);
      if (ws.current && ws.current === event.target) {
        ws.current = null;
      }
    };
  }, [toast]);


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
      if (streamingStateRef.current !== 'error') setStreamingState("error");
    }

    connectWebSocket();

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
      if (streamingStateRef.current !== 'error') setStreamingState("error");
      toast({
        title: "Navegador Incompatível",
        description: "Seu navegador não suporta a API Web Speech.",
        variant: "destructive",
      });
    }
  }, [isSpeechRecognitionSupported, toast]);


  const startMediaRecorder = useCallback(async (): Promise<boolean> => {
    if (!supportedMimeType) {
      setError("Formato de áudio não suportado para gravação.");
      toast({ title: "Erro de Gravação", description: "Formato de áudio não suportado.", variant: "destructive" });
      return false;
    }

    audioChunksRef.current = [];
    console.log("[Client] audioChunksRef limpo no início de startMediaRecorder.");

    if (mediaRecorderRef.current && mediaRecorderRef.current.stream && mediaRecorderRef.current.state !== "inactive") {
        console.warn("[Client] MediaRecorder existente encontrado. Parando trilhas antigas e MR.");
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        if (mediaRecorderRef.current.state === "recording") {
            try { mediaRecorderRef.current.stop(); } catch(e) {console.warn("Erro ao parar MR antigo em startMediaRecorder", e)}
        }
        mediaRecorderRef.current = null;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      console.log("[Client] Novo MediaRecorder criado.");

      mediaRecorderRef.current.ondataavailable = (event: any) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
           console.log(`[Client] MediaRecorder.ondataavailable: chunk adicionado. Total chunks: ${audioChunksRef.current.length}, tamanho do chunk: ${event.data.size}`);
        }
      };
      
      mediaRecorderRef.current.onstop = () => { 
         console.log(`[Client] MediaRecorder PARADO (onstop GENÉRICO). Estado MR: ${mediaRecorderRef.current?.state}, Chunks: ${audioChunksRef.current.length}`);
         if (mediaRecorderRef.current && mediaRecorderRef.current.stream) {
              mediaRecorderRef.current.stream.getTracks().forEach(t => t.stop());
         }
      };

      mediaRecorderRef.current.start(1000); // Coleta chunks a cada 1 segundo
      console.log("[Client] MediaRecorder iniciado com timeslice 1000ms.");
      return true;
    } catch (err) {
      console.error("[Client] Erro ao iniciar MediaRecorder:", err);
      setError("Falha ao acessar o microfone para gravação.");
      toast({ title: "Erro de Microfone", description: "Não foi possível iniciar a gravação de áudio.", variant: "destructive" });
      setStreamingState("error"); // Atualiza o estado
      return false;
    }
  }, [supportedMimeType, toast]);


  const sendDataToServer = useCallback(async (text: string) => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
      console.warn("[Client] WebSocket não está aberto. Tentando reconectar e enviar.");
      connectWebSocket();
      await new Promise(resolve => setTimeout(resolve, 500)); // Pequena pausa para a conexão estabilizar
      if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
          setError("Conexão perdida. Não foi possível enviar dados. Tente novamente.");
          setIsTranslating(false);
          return;
      }
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

    audioChunksRef.current = []; // Limpa os chunks após criar o blob para o envio atual
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
          setError("Conexão perdida antes do envio. Tente novamente.");
          setIsTranslating(false);
        }
      };
      reader.onerror = async () => {
        console.error("[Client] Erro ao ler Blob como Data URI.");
        setIsTranslating(false);
        setError("Erro ao processar áudio para envio.");
      };
      reader.readAsDataURL(blobToActuallySend);
    } else {
      console.warn(`[Client] Não enviando (sendDataToServer): Texto vazio ou Blob de áudio nulo/vazio (tamanho: ${blobToActuallySend?.size ?? 0}) para texto: "${text.substring(0,30)}..."`);
      if (!text.trim()) console.log("[Client] Motivo: Texto vazio.");
      if (!blobToActuallySend || blobToActuallySend.size === 0) console.log("[Client] Motivo: Blob de áudio nulo ou vazio.");
      setIsTranslating(false);
    }
  }, [supportedMimeType, sourceLanguage, targetLanguage, connectWebSocket]);

  const stopRecognitionInternals = useCallback((isUnmounting = false) => {
    console.log("[Client] Chamando stopRecognitionInternals.", { isUnmounting, currentState: streamingStateRef.current });
    if (endOfSpeechTimerRef.current) {
      clearTimeout(endOfSpeechTimerRef.current);
      endOfSpeechTimerRef.current = null;
    }

    if (recognition) {
      console.log("[Client] SR: Limpando handlers e abortando em stopRecognitionInternals.");
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onend = null; // Limpa o onend aqui
      try { recognition.abort(); } catch (e) { console.warn("[Client] Erro ao chamar recognition.abort():", e); }
      recognition = null;
    }

    if (mediaRecorderRef.current) {
      console.log("[Client] MR: Limpando handlers e parando em stopRecognitionInternals. Estado atual:", mediaRecorderRef.current.state);
      mediaRecorderRef.current.onstop = null; 
      mediaRecorderRef.current.ondataavailable = null;
      if (mediaRecorderRef.current.state === "recording") {
        try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Erro ao parar MR em stopRecInternals (gravando)", e);}
      }
      if(mediaRecorderRef.current.stream){ // Garante que a stream e suas trilhas sejam paradas
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
      mediaRecorderRef.current = null;
    }

    audioChunksRef.current = [];
    accumulatedInterimRef.current = "";
    setInterimTranscribedText("");
    if (!isUnmounting && streamingStateRef.current !== "idle" && streamingStateRef.current !== "error") {
      setStreamingState("idle"); 
      console.log("[Client] stopRecognitionInternals: Estado definido para idle.");
    } else if (streamingStateRef.current === "error" && !isUnmounting) {
      console.log("[Client] stopRecognitionInternals: Estado era error, mantendo error.");
    }
  }, []);


  const startRecognition = useCallback(async () => {
    console.log("[Client] Tentando iniciar/reiniciar reconhecimento (startRecognition). Estado atual:", streamingStateRef.current, "Idioma Fonte:", sourceLanguage);
    
    // Assegura que o estado seja 'recognizing'
    setStreamingState("recognizing");
    
    if (!isSpeechRecognitionSupported()) { setError("Reconhecimento não suportado"); setStreamingState("error"); return; }
    if (!supportedMimeType) { setError("Formato de áudio não suportado"); setStreamingState("error"); return; }

    setTranscribedText("");
    setInterimTranscribedText("");
    setTranslatedText("");
    accumulatedInterimRef.current = "";
    if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        console.log("[Client] WebSocket não conectado em startRecognition. Tentando reconectar...");
        connectWebSocket();
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
            setError("Falha ao conectar ao WebSocket para iniciar reconhecimento.");
            toast({ title: "Erro de Conexão", description: "Servidor WebSocket indisponível.", variant: "destructive" });
            setStreamingState("error");
            return;
        }
    }
    
    setError(null);

    const mediaRecorderStarted = await startMediaRecorder();
    if (!mediaRecorderStarted) {
      setStreamingState("error"); // Estado de erro se MR não iniciar
      return;
    }

    toast({ title: "Microfone Ativado", description: "Iniciando reconhecimento e gravação..." });

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) { setError("API SpeechRecognition não encontrada"); stopRecognitionInternals(); setStreamingState("error"); return; }

    if (recognition && typeof recognition.stop === 'function') {
        console.warn("[Client] Instância de Recognition pré-existente encontrada em startRecognition. Abortando-a.");
        recognition.onresult = null;
        recognition.onerror = null;
        recognition.onstart = null;
        recognition.onend = null;
        try { recognition.abort(); } catch(e) { console.warn("[Client] Erro ao abortar SR pre-existente", e); }
        recognition = null;
    }
    try {
      recognition = new SpeechRecognitionAPI();
    } catch (e: any) { setError(`Erro ao criar SpeechRecognition: ${e.message}`); stopRecognitionInternals(); setStreamingState("error"); return; }

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

    recognition.onresult = async (event: any) => {
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

      let finalTranscriptForThisSegment = "";
      let currentEventInterimTranscript = "";

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcriptPart = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          finalTranscriptForThisSegment += transcriptPart;
        } else {
          currentEventInterimTranscript += transcriptPart;
        }
      }
      
      finalTranscriptForThisSegment = finalTranscriptForThisSegment.trim();

      if (finalTranscriptForThisSegment) {
        console.log(`[Client] Texto final de segmento recebido: "${finalTranscriptForThisSegment}"`);
        setTranscribedText(prev => (prev ? prev.trim() + " " : "") + finalTranscriptForThisSegment);
        setInterimTranscribedText("");
        accumulatedInterimRef.current = "";

        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
                console.log(`[Client] MediaRecorder.onstop (para final_transcript): "${finalTranscriptForThisSegment}"`);
                await sendDataToServer(finalTranscriptForThisSegment);
                // O reinício agora é tratado pelo onend do recognition
                if (recognition) recognition.stop(); // Força onend para o ciclo de reinício
            };
            try { mediaRecorderRef.current.stop(); } catch(e) { 
                console.warn("Erro ao parar MR para final transcript:", e); 
                // Se MR falhar ao parar, ainda tenta enviar dados e parar SR
                await sendDataToServer(finalTranscriptForThisSegment); 
                if(recognition) recognition.stop();
            }
        } else {
            console.warn(`[Client] MediaRecorder não gravando ou nulo para final_transcript: "${finalTranscriptForThisSegment}". Estado: ${mediaRecorderRef.current?.state}. Chunks: ${audioChunksRef.current.length}. Tentando enviar e parar SR.`);
            await sendDataToServer(finalTranscriptForThisSegment); // Tenta enviar com os chunks que tem
            if (recognition) recognition.stop(); // Força onend
        }
      } else if (currentEventInterimTranscript) {
        accumulatedInterimRef.current = currentEventInterimTranscript;
        setInterimTranscribedText(accumulatedInterimRef.current);

        endOfSpeechTimerRef.current = setTimeout(async () => {
          const interimToProcess = accumulatedInterimRef.current.trim();
          accumulatedInterimRef.current = "";
          setInterimTranscribedText("");

          if (interimToProcess && streamingStateRef.current === "recognizing") {
            console.log(`[Client] Timeout de fim de fala. Processando interino como final: "${interimToProcess}"`);
            setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcess);

            if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                mediaRecorderRef.current.onstop = async () => {
                    console.log(`[Client] MediaRecorder.onstop (para timeout interino): "${interimToProcess}"`);
                    await sendDataToServer(interimToProcess);
                    if (recognition) recognition.stop(); // Força onend
                };
                try { mediaRecorderRef.current.stop(); } catch(e) { 
                    console.warn("Erro ao parar MR para timeout interino:", e); 
                    await sendDataToServer(interimToProcess);
                    if(recognition) recognition.stop();
                }
            } else {
                console.warn(`[Client] MediaRecorder não gravando ou nulo para timeout interino: "${interimToProcess}". Estado: ${mediaRecorderRef.current?.state}. Tentando enviar e parar SR.`);
                await sendDataToServer(interimToProcess);
                if (recognition) recognition.stop(); // Força onend
            }
          }
        }, END_OF_SPEECH_TIMEOUT_MS);
      }
    };

    recognition.onerror = (event: any) => {
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);
      console.error("[Client] Erro no SpeechRecognition:", event.error, event.message);
      let errMessage = `Erro no reconhecimento: ${event.error}`;
      
      const interimOnError = accumulatedInterimRef.current.trim();
      if (interimOnError && (event.error === 'no-speech' || event.error === 'network' || event.error === 'audio-capture')) {
          console.log(`[Client] Erro SR '${event.error}' com interino: "${interimOnError}". Processando como final e tentando continuar.`);
          setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimOnError);
          accumulatedInterimRef.current = "";
          setInterimTranscribedText("");
          
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
               await sendDataToServer(interimOnError);
               if (recognition) recognition.stop(); // Deixa o onend decidir se reinicia
            };
            try { mediaRecorderRef.current.stop(); } catch(e) { if(recognition)recognition.stop(); }
          } else {
            (async ()=>{ 
                await sendDataToServer(interimOnError); 
                if (recognition) recognition.stop(); // Deixa o onend decidir
            })();
          }
          return; // Evita definir como erro fatal imediatamente, deixa onend lidar
      }
      
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        errMessage = "Permissão do microfone negada ou serviço não permitido.";
      } else if (event.error === 'language-not-supported') {
        errMessage = `Idioma '${recognition?.lang}' não suportado.`;
      } else if (event.error === 'aborted') {
        console.log("[Client] SpeechRecognition aborted.");
      }
      
      setError(errMessage);
      setStreamingState("error"); 
      if (recognition) recognition.stop(); // Garante que o onend seja chamado para limpeza, que chamará stopRecognitionInternals
      else stopRecognitionInternals(); // Se recognition for nulo, limpa diretamente

      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
      }
    };

    recognition.onend = async () => {
      console.log(`[Client] SpeechRecognition.onend disparado. Estado atual (ref): ${streamingStateRef.current}`);
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

      if (streamingStateRef.current === "recognizing") {
        // Se o onend for chamado e ainda estamos "recognizing", significa que um segmento terminou
        // e queremos iniciar o próximo.
        console.log("[Client] SR.onend: Estado é 'recognizing'. Reiniciando o ciclo...");
        await startRecognition(); // Chama startRecognition para reiniciar MR e SR
      } else if (streamingStateRef.current === "stopping") {
        console.log("[Client] SR.onend: Estado é 'stopping'. Chamando stopRecognitionInternals para limpeza final.");
        stopRecognitionInternals(); // Limpa e define para 'idle'
      } else if (streamingStateRef.current === "error") {
        console.log("[Client] SR.onend: Estado é 'error'. Chamando stopRecognitionInternals para limpeza (mantendo erro).");
        stopRecognitionInternals(); // Limpa, mas o estado deve permanecer 'error' se definido anteriormente
      } else {
         console.log(`[Client] SR.onend: Estado é '${streamingStateRef.current}' - não fazendo nada específico aqui.`);
      }
    };

    console.log("[Client] Chamando recognition.start()...");
    try {
      recognition.start();
    } catch (e: any) {
      console.error("[Client] Erro ao chamar recognition.start():", e);
      setError(`Erro ao iniciar reconhecimento: ${e.message}`);
      setStreamingState("error");
      if (recognition) recognition.stop(); else stopRecognitionInternals();
    }
  }, [isSpeechRecognitionSupported, supportedMimeType, sourceLanguage, sendDataToServer, stopRecognitionInternals, connectWebSocket, toast, startMediaRecorder]);


  const stopRecognition = useCallback(async () => {
    console.log("[Client] Tentando parar reconhecimento (stopRecognition)... Estado atual (ref):", streamingStateRef.current);
    if (streamingStateRef.current === "idle" || streamingStateRef.current === "error" || streamingStateRef.current === "stopping") {
        console.log("[Client] Já está idle, em erro ou parando. stopRecognition não fará nada a mais.");
        return;
    }

    setStreamingState("stopping"); // Define o estado para 'stopping'
    
    if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

    const interimToProcessOnStop = accumulatedInterimRef.current.trim();
    if (interimToProcessOnStop) {
        console.log(`[Client] Parando. Processando interino acumulado final: "${interimToProcessOnStop}"`);
        setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcessOnStop);
        accumulatedInterimRef.current = "";
        setInterimTranscribedText("");

        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
                console.log(`[Client] MR.onstop durante stopRecognition para interino: "${interimToProcessOnStop}"`);
                await sendDataToServer(interimToProcessOnStop);
                if (recognition) recognition.stop(); // Aciona onend, que com estado "stopping" chamará stopRecognitionInternals
            };
            try { mediaRecorderRef.current.stop(); } catch (e) { 
                console.warn("Error stopping MR during stopRecognition for interim", e); 
                await sendDataToServer(interimToProcessOnStop); 
                if(recognition) recognition.stop(); 
            }
        } else {
           await sendDataToServer(interimToProcessOnStop);
           if (recognition) recognition.stop(); // Aciona onend
        }
    } else if (recognition) {
        console.log("[Client] stopRecognition: Sem interino. Chamando recognition.stop().");
        recognition.stop(); // Aciona onend, que com estado "stopping" chamará stopRecognitionInternals
    } else {
        console.log("[Client] stopRecognition: recognition é nulo. Chamando stopRecognitionInternals para garantir limpeza e estado idle.");
        stopRecognitionInternals(); 
    }
  }, [sendDataToServer, stopRecognitionInternals]);


  const handleToggleStreaming = () => {
    console.log("[Client] handleToggleStreaming chamado. Estado atual:", streamingState);
    if (streamingState === "recognizing") {
      stopRecognition();
    } else if (streamingState === "idle" || streamingState === "error") {
      if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        console.log("[Client] WebSocket não conectado ou fechado. Tentando reconectar antes de iniciar...");
        connectWebSocket();
        setTimeout(() => {
          if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            startRecognition();
          } else {
            setError("Falha ao conectar ao WebSocket. Não é possível iniciar a transcrição.");
            toast({ title: "Erro de Conexão", description: "Não foi possível conectar ao servidor para iniciar.", variant: "destructive"});
            if (streamingStateRef.current !== 'error') setStreamingState("error");
          }
        }, 750);
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
               <div className="min-h-[20px] flex flex-col items-center justify-center space-y-1 text-sm">
                {!supportedMimeType && streamingState !== "error" && streamingState !== "idle" && (
                  <p className="text-destructive">Gravação de áudio não suportada neste navegador.</p>
                )}
                {(streamingState === "recognizing") && !isTranslating && (
                  <p className="text-primary animate-pulse">Reconhecendo e gravando...</p>
                )}
                {isTranslating && (
                  <p className="text-accent animate-pulse">Traduzindo...</p>
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


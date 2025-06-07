
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
const END_OF_SPEECH_TIMEOUT_MS = 2000; // Aumentado para dar mais margem

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
  }, [streamingState, toast]); // Adicionado streamingState e toast

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
      if (endOfSpeechTimerRef.current) {
        clearTimeout(endOfSpeechTimerRef.current);
        endOfSpeechTimerRef.current = null;
      }
      accumulatedInterimRef.current = "";

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
    console.log("[Client] audioChunksRef limpo no início de startMediaRecorder.");
    audioChunksRef.current = [];

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        console.log("[Client] MediaRecorder já está gravando. Parando o anterior antes de reiniciar.");
        mediaRecorderRef.current.ondataavailable = null;
        mediaRecorderRef.current.onstop = null;
        try {
            mediaRecorderRef.current.stop();
            // Permite um pequeno tempo para o processo de parada
            await new Promise(resolve => setTimeout(resolve, 50));
        } catch (e) {
            console.warn("[Client] Erro ao parar MediaRecorder existente em startMediaRecorder:", e);
        }
    }
     if (mediaRecorderRef.current && mediaRecorderRef.current.stream) {
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        console.log("[Client] Trilhas de mídia do MediaRecorder anterior paradas.");
    }
    mediaRecorderRef.current = null;

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
      
      mediaRecorderRef.current.onstop = () => { // Default onstop - pode ser sobrescrito
        console.log("[Client] MediaRecorder parado (onstop genérico). Estado MR:", mediaRecorderRef.current?.state);
        if (mediaRecorderRef.current) {
             const s = mediaRecorderRef.current.stream;
             if(s) s.getTracks().forEach(t => t.stop());
        }
      };

      mediaRecorderRef.current.start(1000); 
      console.log("[Client] MediaRecorder iniciado com timeslice 1000ms.");
      return true;
    } catch (err) {
      console.error("[Client] Erro ao iniciar MediaRecorder:", err);
      setError("Falha ao acessar o microfone para gravação de áudio.");
      toast({ title: "Erro de Microfone", description: "Não foi possível iniciar a gravação de áudio.", variant: "destructive" });
      setStreamingState("error");
      return false;
    }
  }, [supportedMimeType, toast, setError]); // Adicionado setError

  // Movido sendDataAndPrepareNext para ser definido antes de startRecognition e outros que dependem dela
  const sendDataAndPrepareNext = useCallback(async (text: string, isTextFinalForSegment: boolean) => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
      console.warn("[Client] WebSocket não está aberto. Não é possível enviar dados.");
      setError("Conexão perdida. Não foi possível enviar dados.");
      setIsTranslating(false);
      return; // Não tentar reiniciar aqui, o restart é responsabilidade do chamador
    }
    if (!supportedMimeType) {
      console.warn("[Client] MimeType não suportado. Não é possível enviar áudio.");
      setIsTranslating(false);
      return;
    }

    let blobToActuallySend: Blob | null = null;
    if (audioChunksRef.current.length > 0) {
        blobToActuallySend = new Blob(audioChunksRef.current, { type: supportedMimeType });
        console.log(`[Client] sendDataAndPrepareNext: Criado Blob de ${audioChunksRef.current.length} chunks, tamanho: ${blobToActuallySend.size} bytes para o texto "${text.substring(0,30)}..."`);
    } else {
        console.warn(`[Client] sendDataAndPrepareNext: Nenhum chunk de áudio para criar Blob para o texto: "${text.substring(0,30)}..."`);
    }
    
    // Limpar chunks após criar o blob para este envio. O MediaRecorder continua adicionando se estiver rodando.
    console.log("[Client] audioChunksRef limpo em sendDataAndPrepareNext (após criar blob).");
    audioChunksRef.current = [];


    if (text.trim() && blobToActuallySend && blobToActuallySend.size > 0) {
      setIsTranslating(true);
      const reader = new FileReader();
      reader.onloadend = async () => {
        const audioDataUri = reader.result as string;
        console.log(`[Client] Enviando texto (final para segmento: ${isTextFinalForSegment}): "${text.substring(0,30)}..." e áudio (${(blobToActuallySend!.size / 1024).toFixed(2)} KB).`);
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
      console.warn(`[Client] Não enviando: Texto vazio ou Blob de áudio nulo/vazio (tamanho: ${blobToActuallySend?.size ?? 0}) para texto: "${text.substring(0,30)}..."`);
      if (!text.trim()) console.log("[Client] Motivo: Texto vazio.");
      if (!blobToActuallySend || blobToActuallySend.size === 0) console.log("[Client] Motivo: Blob de áudio nulo ou vazio.");
      setIsTranslating(false);
    }
  }, [ws, supportedMimeType, sourceLanguage, targetLanguage, setIsTranslating, setError]); // Removido streamingState, startMediaRecorder, toast, accumulatedInterimRef, setInterimTranscribedText, setTranscribedText - o reinício é tratado pelo chamador.

  const stopRecognitionInternals = useCallback(() => {
    console.log("[Client] Chamando stopRecognitionInternals.");
     if (recognitionRestartTimer) {
        clearTimeout(recognitionRestartTimer);
        recognitionRestartTimer = null;
    }
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
        recognition.stop(); 
        console.log("[Client] recognition.stop() chamado em stopRecognitionInternals.");
      } catch (e) {
         console.warn("[Client] Erro ao chamar recognition.stop(), tentando abort():", e);
         try { recognition.abort(); } catch (e2) { console.warn("Erro ao chamar recognition.abort()", e2); }
      }
      recognition = null;
    }
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.onstop = () => { 
            console.log("[Client] MediaRecorder parado por stopRecognitionInternals (estava gravando).");
            if (mediaRecorderRef.current) {
                const stream = mediaRecorderRef.current.stream;
                if (stream) stream.getTracks().forEach(track => track.stop());
                mediaRecorderRef.current = null;
            }
        };
        try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Erro ao parar MR em stopRecInternals (gravando)");}
      } else { 
        if(mediaRecorderRef.current.stream){
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
        mediaRecorderRef.current = null;
      }
    }
    console.log("[Client] audioChunksRef limpo em stopRecognitionInternals.");
    audioChunksRef.current = [];
    accumulatedInterimRef.current = ""; 
    setInterimTranscribedText("");    
  }, [setInterimTranscribedText]);


  const startRecognition = useCallback(async () => {
    console.log("[Client] Tentando iniciar reconhecimento. Estado atual:", streamingState, "Idioma Fonte:", sourceLanguage);
    if (!isSpeechRecognitionSupported()) { setError("Reconhecimento não suportado"); return; }
    if (!supportedMimeType) { setError("Formato de áudio não suportado"); return; }

    if (streamingState === "recognizing" || streamingState === "stopping") {
      console.warn("[Client] Tentando iniciar reconhecimento quando já está em progresso ou parando.");
      return;
    }
    
    setTranscribedText("");
    setInterimTranscribedText("");
    setTranslatedText("");
    accumulatedInterimRef.current = "";
    if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);
    if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer);

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

    try {
      if (recognition && typeof recognition.stop === 'function') {
        recognition.onend = null; 
        recognition.abort();      
      }
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
    console.log(`[Client] Instância SpeechRecognition criada. Idioma: ${recognition.lang}`);

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer);
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
        accumulatedInterimRef.current = ""; // Limpa interino acumulado pois temos um final
        setInterimTranscribedText("");

        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
                console.log(`[Client] MediaRecorder.onstop (para final_transcript): "${finalTranscriptForThisSegment}"`);
                await sendDataAndPrepareNext(finalTranscriptForThisSegment, true); 
                if (streamingState === "recognizing") { // Verifica se ainda deve continuar
                    console.log("[Client] MR.onstop (final): Reiniciando MR e SR");
                    await startMediaRecorder();
                    if (recognition && typeof recognition.start === 'function') {
                        try { recognition.start(); } catch(e) { console.error("Erro ao reiniciar SR em MR.onstop(final)", e); }
                    }
                }
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
            };
            try { mediaRecorderRef.current.stop(); } catch(e) { 
                console.warn("Error stopping MR for final transcript:", e);
                // Tenta enviar e reiniciar mesmo assim
                (async () => {
                    await sendDataAndPrepareNext(finalTranscriptForThisSegment, true);
                    if (streamingState === "recognizing") {
                        await startMediaRecorder();
                        if (recognition && typeof recognition.start === 'function') {
                             try { recognition.start(); } catch(err) { console.error("Erro ao reiniciar SR pós-erro de parada MR(final)", err); }
                        }
                    }
                })();
            }
        } else {
            console.warn(`[Client] MediaRecorder não gravando ou nulo para final_transcript: "${finalTranscriptForThisSegment}". Estado: ${mediaRecorderRef.current?.state}. Chunks: ${audioChunksRef.current.length}. Tentando enviar e reiniciar.`);
             (async () => {
                await sendDataAndPrepareNext(finalTranscriptForThisSegment, true);
                if (streamingState === "recognizing") {
                     await startMediaRecorder();
                     if (recognition && typeof recognition.start === 'function') {
                         try { recognition.start(); } catch(e) { console.error("Erro ao reiniciar SR (MR não gravando, final)", e); }
                     }
                }
            })();
        }
      } else if (interimTranscriptForCurrentEvent) {
        accumulatedInterimRef.current = interimTranscriptForCurrentEvent; // Atualiza o interino acumulado completo para esta elocução
        setInterimTranscribedText(accumulatedInterimRef.current);

        endOfSpeechTimerRef.current = setTimeout(() => {
          const interimToProcess = accumulatedInterimRef.current.trim();
          if (interimToProcess && streamingState === "recognizing") { 
            console.log(`[Client] Timeout de fim de fala (${END_OF_SPEECH_TIMEOUT_MS}ms). Processando interino como final: "${interimToProcess}"`);
            setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcess);
            accumulatedInterimRef.current = "";
            setInterimTranscribedText("");

            if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                mediaRecorderRef.current.onstop = async () => {
                    console.log(`[Client] MediaRecorder.onstop (para timeout interino): "${interimToProcess}"`);
                    await sendDataAndPrepareNext(interimToProcess, true);
                     if (streamingState === "recognizing") {
                        console.log("[Client] MR.onstop (interim timeout): Reiniciando MR e SR");
                        await startMediaRecorder();
                        if (recognition && typeof recognition.start === 'function') {
                             try { recognition.start(); } catch(e) { console.error("Erro ao reiniciar SR em MR.onstop(interim)", e); }
                        }
                    }
                    if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                };
                try { mediaRecorderRef.current.stop(); } catch(e) { 
                    console.warn("Error stopping MR for interim timeout:", e);
                    (async () => {
                        await sendDataAndPrepareNext(interimToProcess, true);
                        if (streamingState === "recognizing") {
                            await startMediaRecorder();
                            if (recognition && typeof recognition.start === 'function') {
                                 try { recognition.start(); } catch(err) { console.error("Erro ao reiniciar SR pós-erro de parada MR(interim)", err); }
                            }
                        }
                    })();
                }
            } else {
                console.warn(`[Client] MediaRecorder não gravando ou nulo para timeout interino: "${interimToProcess}". Estado: ${mediaRecorderRef.current?.state}. Chunks: ${audioChunksRef.current.length}. Tentando enviar e reiniciar.`);
                (async () => {
                    await sendDataAndPrepareNext(interimToProcess, true);
                    if (streamingState === "recognizing") {
                        await startMediaRecorder();
                        if (recognition && typeof recognition.start === 'function') {
                             try { recognition.start(); } catch(e) { console.error("Erro ao reiniciar SR (MR não gravando, interim)", e); }
                        }
                    }
                })();
            }
          }
        }, END_OF_SPEECH_TIMEOUT_MS);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer);
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

      console.error("[Client] Erro no SpeechRecognition:", event.error, event.message);
      let errMessage = `Erro no reconhecimento: ${event.error}`;
      
      const interimOnError = accumulatedInterimRef.current.trim();
      if (interimOnError && (event.error === 'no-speech' || event.error === 'network' || event.error === 'audio-capture')) {
          console.log(`[Client] Erro SR '${event.error}', com interino: "${interimOnError}". Processando como final.`);
          setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimOnError);
          accumulatedInterimRef.current = "";
          setInterimTranscribedText("");
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
               await sendDataAndPrepareNext(interimOnError, true); 
               if (streamingState === "recognizing") {
                   await startMediaRecorder();
                   if(recognition && typeof recognition.start === 'function') try {recognition.start();} catch(e){console.error("SR restart err in onerror",e)}
               }
               if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
            };
            try { mediaRecorderRef.current.stop(); } catch(e) { console.warn("Error stopping MR on error with interim:", e); (async ()=>{ await sendDataAndPrepareNext(interimOnError, true); if(streamingState==="recognizing"){await startMediaRecorder();if(recognition)recognition.start();} })(); }
          } else {
            (async ()=>{ await sendDataAndPrepareNext(interimOnError, true); if(streamingState==="recognizing"){await startMediaRecorder();if(recognition)recognition.start();} })();
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
      } else if (streamingState === "recognizing" && recognition && typeof recognition.start === 'function' && event.error !== 'aborted') { // Evita restart no 'aborted'
        console.log(`[Client] Tentando reiniciar recognition após erro: ${event.error}.`);
        try {
          recognition.start(); 
        } catch(e) { 
          console.error("Erro no start() pós-erro não crítico", e);
        }
      }
      
      setError(errMessage);
      if (event.error !== 'no-speech' || interimOnError) { 
        toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
      }
    };

    recognition.onend = () => {
      console.log("[Client] SpeechRecognition.onend disparado. Estado atual:", streamingState);
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

      if (streamingState === "recognizing") {
        const interimOnEnd = accumulatedInterimRef.current.trim();
        if (interimOnEnd) {
            console.log(`[Client] Recognition.onend com interino: "${interimOnEnd}". Processando como final.`);
            setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimOnEnd);
            accumulatedInterimRef.current = "";
            setInterimTranscribedText("");
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
              mediaRecorderRef.current.onstop = async () => {
                await sendDataAndPrepareNext(interimOnEnd, true); 
                if (streamingState === "recognizing") {
                   await startMediaRecorder();
                   if(recognition && typeof recognition.start === 'function') try {recognition.start();} catch(e){console.error("SR restart err in onend",e)}
                }
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
              }
              try { mediaRecorderRef.current.stop(); } catch(e) { console.warn("Error stopping MR onend with interim", e); (async ()=>{ await sendDataAndPrepareNext(interimOnEnd, true); if(streamingState==="recognizing"){await startMediaRecorder();if(recognition)recognition.start();} })(); }
            } else {
              (async ()=>{ await sendDataAndPrepareNext(interimOnEnd, true); if(streamingState==="recognizing"){await startMediaRecorder();if(recognition)recognition.start();} })();
            }
        } else if (recognition && typeof recognition.start === 'function' && streamingState === 'recognizing') { 
            console.log("[Client] SR.onend: Reconhecimento terminou (streamingState 'recognizing', sem interino). Tentando reiniciar SR em 250ms se não estiver parando manualmente.");
            if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer);
            recognitionRestartTimer = setTimeout(() => {
              if (streamingState === "recognizing") { 
                if (recognition && typeof recognition.start === 'function') {
                  console.log("[Client] Reiniciando recognition após onend e timeout (sem interino).");
                  try { recognition.start(); } catch(e) { console.error("Erro no start() pós-onend (sem interino)", e); }
                } else if (!recognition && streamingState === "recognizing") {
                  console.log("[Client] Recognition é nulo pós-onend e timeout. Tentando startRecognition() completo.");
                  startRecognition(); 
                }
              }
            }, 250);
        }
      } else if (streamingState === "stopping") {
        console.log("[Client] SpeechRecognition.onend: Transcrição estava parando, definindo estado para idle.");
        setStreamingState("idle"); 
      }
    };

    console.log("[Client] Chamando recognition.start()...");
    try {
       if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer);
       if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);
      recognition.start();
    } catch (e: any) {
      console.error("[Client] Erro ao chamar recognition.start():", e);
      setError(`Erro ao iniciar reconhecimento: ${e.message}`);
      setStreamingState("error");
      stopRecognitionInternals();
    }
  }, [isSpeechRecognitionSupported, supportedMimeType, streamingState, sourceLanguage, sendDataAndPrepareNext, stopRecognitionInternals, connectWebSocket, toast, setError, setTranscribedText, setInterimTranscribedText, setTranslatedText, startMediaRecorder]);


  const stopRecognition = useCallback(() => {
    console.log("[Client] Tentando parar reconhecimento (stopRecognition)... Estado atual:", streamingState);
    if (streamingState !== "recognizing") {
        console.log("[Client] Não estava reconhecendo. Parando quaisquer internos e definindo para idle.");
        if (streamingState !== "idle") setStreamingState("idle"); 
        stopRecognitionInternals();
        return;
    }

    setStreamingState("stopping"); 

    if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);
    if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer);

    const interimToProcessOnStop = accumulatedInterimRef.current.trim();
    if (interimToProcessOnStop) {
        console.log(`[Client] Parando. Processando interino acumulado final: "${interimToProcessOnStop}"`);
        setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcessOnStop);
        
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
                console.log(`[Client] MR.onstop durante stopRecognition para interino: "${interimToProcessOnStop}"`);
                await sendDataAndPrepareNext(interimToProcessOnStop, true); // Envia como final, mas não reinicia
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                stopRecognitionInternals(); 
                setStreamingState("idle");
            };
            try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Error stopping MR during stopRecognition", e); (async ()=>{await sendDataAndPrepareNext(interimToProcessOnStop, true); stopRecognitionInternals(); setStreamingState("idle");})(); }
        } else {
            (async ()=>{await sendDataAndPrepareNext(interimToProcessOnStop, true); stopRecognitionInternals(); setStreamingState("idle");})();
        }
    } else {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
                console.log(`[Client] MR.onstop durante stopRecognition (sem interino).`);
                // Envia qualquer áudio restante com texto vazio, ou apenas para.
                // O false em sendData indica que não é um segmento final de fala necessariamente.
                await sendDataAndPrepareNext("", true); 
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                stopRecognitionInternals();
                setStreamingState("idle");
            };
            try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Error stopping MR during stop (no interim)", e); stopRecognitionInternals(); setStreamingState("idle");}
        } else {
            stopRecognitionInternals();
            setStreamingState("idle");
        }
    }
  }, [streamingState, stopRecognitionInternals, sendDataAndPrepareNext, accumulatedInterimRef, setTranscribedText]);


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
        <p className="mt-1">Transcrição local via Web Speech API. Gravação local via MediaRecorder. Tradução via servidor Genkit.</p>
      </footer>
    </div>
  );
}


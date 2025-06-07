
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
const END_OF_SPEECH_TIMEOUT_MS = 1500; // Tempo de pausa para considerar fala como finalizada

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
  }, [streamingState, toast]); // Adicionado toast aqui, pois é usado em onerror

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

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
        console.log("[Client] MediaRecorder já está gravando. Parando o anterior e reiniciando.");
        mediaRecorderRef.current.onstop = null; 
        try {
            mediaRecorderRef.current.stop();
        } catch (e) {
            console.warn("[Client] Erro ao parar MediaRecorder existente em startMediaRecorder:", e);
        }
        // Aguardar um pouco para garantir que o MediaRecorder anterior seja totalmente parado
        await new Promise(resolve => setTimeout(resolve, 50)); 
    }
     if (mediaRecorderRef.current && mediaRecorderRef.current.stream) {
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        console.log("[Client] Trilhas de mídia do MediaRecorder anterior paradas.");
    }
    mediaRecorderRef.current = null; // Garante que estamos criando um novo
    audioChunksRef.current = []; // Limpa chunks antes de uma nova gravação

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      console.log("[Client] Novo MediaRecorder criado. audioChunksRef limpo.");

      mediaRecorderRef.current.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
           console.log(`[Client] MediaRecorder.ondataavailable: chunk adicionado. Total chunks: ${audioChunksRef.current.length}`);
        }
      };
      
      mediaRecorderRef.current.onstop = () => { // Handler genérico
        console.log("[Client] MediaRecorder parado (onstop genérico). Estado SR:", streamingState);
        if (mediaRecorderRef.current) {
             const s = mediaRecorderRef.current.stream;
             if(s) s.getTracks().forEach(t => t.stop());
             console.log("[Client] Trilhas de mídia paradas (onstop genérico).");
        }
        // Não redefine mediaRecorderRef.current = null aqui, isso deve ser feito em stopRecognitionInternals
        // ou quando um novo é criado em startMediaRecorder
      };

      mediaRecorderRef.current.start(1000); // Coleta chunks a cada 1 segundo
      console.log("[Client] MediaRecorder iniciado com timeslice 1000ms.");
      return true;
    } catch (err) {
      console.error("[Client] Erro ao iniciar MediaRecorder:", err);
      setError("Falha ao acessar o microfone para gravação de áudio.");
      toast({ title: "Erro de Microfone", description: "Não foi possível iniciar a gravação de áudio.", variant: "destructive" });
      setStreamingState("error");
      return false;
    }
  }, [supportedMimeType, toast, setError]);


  const sendDataAndPrepareNext = useCallback((text: string, isFinalSegment: boolean) => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
      console.warn("[Client] WebSocket não está aberto. Não é possível enviar dados.");
      setError("Conexão perdida. Não foi possível enviar dados.");
      setIsTranslating(false); // Reset translating state
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
        console.log(`[Client] sendDataAndPrepareNext: Criado Blob de ${audioChunksRef.current.length} chunks, tamanho: ${blobToActuallySend.size} bytes para o texto "${text.substring(0,30)}..."`);
    } else {
        console.warn(`[Client] sendDataAndPrepareNext: Nenhum chunk de áudio para criar Blob para o texto: "${text.substring(0,30)}..."`);
    }
    
    // Limpa chunks globais *após* tentar criar o blob.
    // É importante limpar aqui para que a próxima gravação comece com chunks limpos.
    audioChunksRef.current = []; 
    console.log("[Client] audioChunksRef limpo em sendDataAndPrepareNext.");


    if (text.trim() && blobToActuallySend && blobToActuallySend.size > 0) {
      setIsTranslating(true);
      const reader = new FileReader();
      reader.onloadend = () => {
        const audioDataUri = reader.result as string;
        console.log(`[Client] Enviando texto (final: ${isFinalSegment}): "${text.substring(0,30)}..." e áudio (${(blobToActuallySend!.size / 1024).toFixed(2)} KB).`);
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
      reader.onerror = () => {
        console.error("[Client] Erro ao ler Blob como Data URI.");
        setIsTranslating(false);
      };
      reader.readAsDataURL(blobToActuallySend);
    } else {
      console.warn(`[Client] Não enviando: Texto vazio ou Blob de áudio nulo/vazio (tamanho: ${blobToActuallySend?.size ?? 0}) para texto: "${text.substring(0,30)}..."`);
      if (!text.trim()) console.log("[Client] Motivo: Texto vazio.");
      if (!blobToActuallySend || blobToActuallySend.size === 0) console.log("[Client] Motivo: Blob de áudio nulo ou vazio.");
      setIsTranslating(false); // Reset se não enviarmos
    }

    // Lógica de reinício do MediaRecorder e SpeechRecognition para o próximo segmento
    if (isFinalSegment && streamingState === "recognizing") {
      console.log("[Client] sendDataAndPrepareNext (final): Preparando para reiniciar SR e MR.");
      if (recognition && typeof recognition.start === 'function') {
        try {
          if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "recording") {
            console.log("[Client] sendDataAndPrepareNext (final): MediaRecorder não estava gravando. Reiniciando MR antes de SR.");
            startMediaRecorder().then(() => {
                if (recognition && streamingState === "recognizing") {
                    console.log("[Client] sendDataAndPrepareNext (final): Reiniciando SpeechRecognition após MR.");
                    recognition.start();
                }
            });
          } else if (!mediaRecorderRef.current) {
            console.log("[Client] sendDataAndPrepareNext (final): MediaRecorder era nulo. Reiniciando MR antes de SR.");
            startMediaRecorder().then(() => {
                 if (recognition && streamingState === "recognizing") {
                    console.log("[Client] sendDataAndPrepareNext (final): Reiniciando SpeechRecognition após MR.");
                    recognition.start();
                }
            });
          } else { // MediaRecorder já está gravando (ou foi reiniciado por startMediaRecorder)
             console.log("[Client] sendDataAndPrepareNext (final): Reiniciando SpeechRecognition (MR deve estar OK).");
             recognition.start();
          }
        } catch(e) {
          console.error("[Client] Erro ao tentar reiniciar recognition em sendDataAndPrepareNext (final):", e);
        }
      } else if (recognition === null && streamingState === "recognizing") {
          console.warn("[Client] sendDataAndPrepareNext (final): recognition era nulo, mas streamingState é recognizing. Isso não deveria acontecer. Tentando recomeçar com startRecognition.");
          // Esta é uma situação de recuperação, idealmente não deveria ser alcançada.
          // startRecognition(); // Cuidado com chamadas recursivas, por enquanto comentada.
      }
    }
  }, [ws, supportedMimeType, sourceLanguage, targetLanguage, setIsTranslating, setError, streamingState, startMediaRecorder, toast, connectWebSocket]);


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
    accumulatedInterimRef.current = "";

    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onend = null; 
      try {
        recognition.stop(); 
        console.log("[Client] recognition.stop() chamado em stopRecognitionInternals.");
      } catch (e) {
         console.warn("[Client] Erro ao chamar recognition.stop() em stopRecognitionInternals:", e);
      }
      recognition = null;
    }
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state === "recording") {
        mediaRecorderRef.current.onstop = () => { // Handler específico para esta parada
            console.log("[Client] MediaRecorder parado por stopRecognitionInternals (estava gravando).");
            if (mediaRecorderRef.current) {
                const stream = mediaRecorderRef.current.stream;
                if (stream) stream.getTracks().forEach(track => track.stop());
                mediaRecorderRef.current = null;
            }
        };
        try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Erro ao parar MR em stopRecInternals (gravando)");}
      } else { // Já estava parado
        const stream = mediaRecorderRef.current.stream;
        if (stream) stream.getTracks().forEach(track => track.stop());
        mediaRecorderRef.current = null;
      }
    }
    audioChunksRef.current = [];
    console.log("[Client] audioChunksRef limpo em stopRecognitionInternals.");
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
    setTranscribedText("");
    setInterimTranscribedText("");
    setTranslatedText("");
    
    const mediaRecorderStarted = await startMediaRecorder();
    if (!mediaRecorderStarted) {
      setStreamingState("error");
      stopRecognitionInternals(); // Garante limpeza se MR falhar
      return;
    }

    toast({ title: "Microfone Ativado", description: "Iniciando reconhecimento e gravação..." });

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
        setError("API de Reconhecimento de Fala não encontrada.");
        setStreamingState("error");
        stopRecognitionInternals();
        return;
    }

    try {
      if (recognition && typeof recognition.stop === 'function') {
        recognition.onend = null; 
        recognition.abort(); // Tenta abortar qualquer instância anterior
      }
      recognition = new SpeechRecognitionAPI();
    } catch (e: any) {
      console.error("[Client] Erro ao criar instância de SpeechRecognition:", e);
      setError(`Erro ao criar SpeechRecognition: ${e.message}`);
      setStreamingState("error");
      stopRecognitionInternals();
      return;
    }

    recognition.continuous = true; // Mantém o reconhecimento ativo
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
      if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer); // Limpa timer de reinício se houver resultado
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current); // Limpa timer de pausa

      let current_segment_final_transcript = "";
      let current_event_interim_transcript = "";

      for (let i = event.resultIndex; i < event.results.length; ++i) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          current_segment_final_transcript += transcript;
        } else {
          current_event_interim_transcript += transcript;
        }
      }
      
      const newFinalText = (accumulatedInterimRef.current + current_segment_final_transcript).trim();

      if (newFinalText && current_segment_final_transcript.trim()) { // Processa se houver um novo segmento final
        console.log(`[Client] Texto final de segmento recebido: "${newFinalText}"`);
        setTranscribedText(prev => (prev ? prev.trim() + " " : "") + newFinalText);
        
        accumulatedInterimRef.current = ""; 
        setInterimTranscribedText("");    
        
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = () => { // Handler específico para esta parada de segmento
                console.log(`[Client] MediaRecorder.onstop (para final_transcript): "${newFinalText}"`);
                sendDataAndPrepareNext(newFinalText, true); // True indica que é um segmento final
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null; // Limpa este handler específico
            };
            mediaRecorderRef.current.stop(); // Para o MR para processar o áudio deste segmento
        } else {
            console.warn(`[Client] MediaRecorder não gravando ou nulo para final_transcript: "${newFinalText}". Estado: ${mediaRecorderRef.current?.state}. Chunks atuais: ${audioChunksRef.current.length}. Processando com chunks existentes.`);
            // Tenta enviar com os chunks que podem existir (embora MR não esteja "recording")
            // Isso pode acontecer se o MR parou um pouco antes do onresult final.
            sendDataAndPrepareNext(newFinalText, true); 
        }

      } else if (current_event_interim_transcript.trim()) {
        accumulatedInterimRef.current = current_event_interim_transcript;
        setInterimTranscribedText(accumulatedInterimRef.current);

        // Configura um timer para o caso de uma pausa na fala
        endOfSpeechTimerRef.current = setTimeout(() => {
          const interimToProcess = accumulatedInterimRef.current.trim();
          if (interimToProcess && streamingState === "recognizing") { // Só processa se ainda estiver reconhecendo
            console.log(`[Client] Timeout de fim de fala (${END_OF_SPEECH_TIMEOUT_MS}ms). Processando interino acumulado como final: "${interimToProcess}"`);
            setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcess);
            
            accumulatedInterimRef.current = ""; 
            setInterimTranscribedText("");    
            
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                mediaRecorderRef.current.onstop = () => { // Handler específico
                    console.log(`[Client] MediaRecorder.onstop (para timeout interino): "${interimToProcess}"`);
                    sendDataAndPrepareNext(interimToProcess, true); // True indica final devido a timeout
                    if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                };
                mediaRecorderRef.current.stop();
            } else {
                console.warn(`[Client] MediaRecorder não gravando ou nulo para timeout interino: "${interimToProcess}". Estado: ${mediaRecorderRef.current?.state}. Chunks atuais: ${audioChunksRef.current.length}. Processando com chunks existentes.`);
                sendDataAndPrepareNext(interimToProcess, true);
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

      if (event.error === 'no-speech') {
        errMessage = "Nenhuma fala detectada.";
        const interimToProcess = accumulatedInterimRef.current.trim();
        if (interimToProcess && streamingState === "recognizing") {
          console.log(`[Client] Erro 'no-speech', com interino: "${interimToProcess}". Processando como final.`);
          setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcess);
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = () => {
              sendDataAndPrepareNext(interimToProcess, true);
              if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
            }
            mediaRecorderRef.current.stop();
          } else {
            sendDataAndPrepareNext(interimToProcess, true);
          }
          accumulatedInterimRef.current = "";
          setInterimTranscribedText("");
        } else if (streamingState === "recognizing" && recognition) {
            console.log("[Client] Erro 'no-speech' sem interino. Reiniciando MR e SR.");
            audioChunksRef.current = []; // Limpa chunks pois não há fala
            console.log("[Client] audioChunksRef limpo devido a no-speech sem interino.");
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                mediaRecorderRef.current.onstop = () => { // Handler específico
                    if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                    if (streamingState === "recognizing") { // Verifica estado novamente
                       startMediaRecorder().then(() => {
                          if (recognition && typeof recognition.start === 'function' && streamingState === "recognizing") recognition.start();
                       });
                    }
                }
                mediaRecorderRef.current.stop();
            } else if (streamingState === "recognizing") { // MR não gravando ou nulo
                startMediaRecorder().then(() => {
                  if (recognition && typeof recognition.start === 'function' && streamingState === "recognizing") recognition.start();
                });
            }
        }
      } else if (event.error === 'audio-capture') errMessage = "Falha na captura de áudio.";
      else if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        errMessage = "Permissão do microfone negada.";
        setStreamingState("error"); 
        stopRecognitionInternals(); // Parada completa
      } else if (event.error === 'language-not-supported') errMessage = `Idioma '${recognition?.lang}' não suportado.`;
      else if (event.message) errMessage += `. Detalhes: ${event.message}`;

      setError(errMessage);
      // Evita toast para 'no-speech' a menos que haja interino, para não ser muito verboso
      if (event.error !== 'no-speech' || (event.error === 'no-speech' && accumulatedInterimRef.current.trim())) { 
        toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
      }
      // Para erros não críticos (que não sejam not-allowed), tenta reiniciar o SR se ainda estivermos "recognizing"
      if (event.error !== 'not-allowed' && event.error !== 'service-not-allowed' && streamingState === "recognizing" && recognition && typeof recognition.start === 'function' && event.error !== 'no-speech') {
        console.log("[Client] Tentando reiniciar recognition após erro não crítico (que não seja no-speech).");
        try { recognition.start(); } catch(e) { console.error("Erro no start() pós-erro não crítico", e); }
      }
    };

    recognition.onend = () => {
      console.log("[Client] SpeechRecognition.onend disparado. Estado atual:", streamingState);
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

      if (streamingState === "recognizing") { // Se terminou inesperadamente enquanto ainda deveríamos estar reconhecendo
        const interimToProcess = accumulatedInterimRef.current.trim();
        if (interimToProcess) { // Se houver texto interino, processa como final
            console.log(`[Client] Recognition.onend com interino: "${interimToProcess}". Processando como final.`);
            setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcess);
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
              mediaRecorderRef.current.onstop = () => {
                sendDataAndPrepareNext(interimToProcess, true);
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
              }
              mediaRecorderRef.current.stop();
            } else {
              sendDataAndPrepareNext(interimToProcess, true);
            }
            accumulatedInterimRef.current = "";
            setInterimTranscribedText("");
        } else { // Sem interino, apenas tenta reiniciar o SR
            console.log("[Client] SR.onend: Reconhecimento terminou (streamingState 'recognizing', sem interino). Tentando reiniciar SR em 250ms.");
            if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer);
            recognitionRestartTimer = setTimeout(() => {
              if (streamingState === "recognizing") { 
                if (recognition && typeof recognition.start === 'function') {
                  console.log("[Client] Reiniciando recognition após onend e timeout (sem interino).");
                  try { recognition.start(); } catch(e) { console.error("Erro no start() pós-onend (sem interino)", e); }
                } else if (!recognition && streamingState === "recognizing") {
                  console.log("[Client] Recognition é nulo pós-onend e timeout. Tentando startRecognition() completo.");
                  startRecognition(); // Tenta recomeçar do zero
                }
              }
            }, 250);
        }
      } else if (streamingState === "stopping") { // Se estávamos parando intencionalmente
        console.log("[Client] SpeechRecognition.onend: Transcrição estava parando, definindo estado para idle.");
        setStreamingState("idle");
        // stopRecognitionInternals já foi chamado por stopRecognition
      }
      // Se streamingState é "idle" ou "error", não faz nada aqui, já foi tratado.
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
    console.log("[Client] Tentando parar reconhecimento (stopRecognition)...");
    if (streamingState !== "recognizing" && streamingState !== "stopping") {
        console.log("[Client] Não estava reconhecendo ou parando. Estado atual:", streamingState);
        if (streamingState !== "idle") setStreamingState("idle");
        stopRecognitionInternals(); // Garante limpeza se chamado em estado inesperado
        return;
    }

    setStreamingState("stopping"); // Sinaliza que estamos no processo de parada
    
    if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);
    if (recognitionRestartTimer) clearTimeout(recognitionRestartTimer);

    const interimToProcess = accumulatedInterimRef.current.trim();
    if (interimToProcess) {
        console.log(`[Client] Parando. Processando interino acumulado final: "${interimToProcess}"`);
        setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcess);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = () => { // Handler para esta parada específica
                sendDataAndPrepareNext(interimToProcess, true); // Envia como final, mas não reiniciará SR pois streamingState será "stopping" ou "idle"
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                stopRecognitionInternals(); // Completa a limpeza após o envio final
                setStreamingState("idle");
            };
            mediaRecorderRef.current.stop();
        } else { // MR não gravando, mas há interino
            sendDataAndPrepareNext(interimToProcess, true);
            stopRecognitionInternals();
            setStreamingState("idle");
        }
        accumulatedInterimRef.current = "";
        setInterimTranscribedText("");
    } else { // Sem interino para processar
        stopRecognitionInternals(); 
        setStreamingState("idle");
    }
  }, [streamingState, stopRecognitionInternals, sendDataAndPrepareNext, accumulatedInterimRef, setTranscribedText, setInterimTranscribedText]);


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



"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Mic, MicOff, Loader2, AlertTriangle, LanguagesIcon, ScreenShare, AudioLines } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { supportedLanguages } from "@/lib/languages";
import { useToast } from "@/hooks/use-toast";
import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Separator } from "@/components/ui/separator";
import Link from "next/link";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";


type StreamingState = "idle" | "recognizing" | "error" | "stopping";
type AudioInputMode = "microphone" | "system";

let recognition: any | null = null;
const END_OF_SPEECH_TIMEOUT_MS = 1500;


export default function LinguaVoxPage() {
  const ws = useRef<WebSocket | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const systemAudioStreamRef = useRef<MediaStream | null>(null);
  const { toast } = useToast();

  const [sourceLanguage, setSourceLanguage] = useState<string>("pt");
  const [targetLanguage, setTargetLanguage] = useState<string>("en");

  const [streamingState, setStreamingState] = useState<StreamingState>("idle");
  const streamingStateRef = useRef<StreamingState>(streamingState);
  useEffect(() => {
    streamingStateRef.current = streamingState;
  }, [streamingState]);

  const [audioInputMode, setAudioInputMode] = useState<AudioInputMode>("microphone");

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
      if (ws.current && ws.current === event.target) { // Garantir que estamos tratando o fechamento da instância correta
        ws.current = null;
      }
       if (streamingStateRef.current !== "idle" && streamingStateRef.current !== "error" && event.code !== 1000) { // Não mostrar erro se foi uma desconexão limpa (código 1000)
        setError("Conexão WebSocket perdida. Tente reiniciar a transcrição.");
        toast({ title: "Conexão Perdida", description: "A conexão com o servidor foi interrompida.", variant: "destructive" });
        if(streamingStateRef.current !== "error") setStreamingState("error");
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
  }, []); // connectWebSocket foi removido das dependências para evitar reconexões excessivas.

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
    console.log("[Client] Iniciando startMediaRecorder");
    if (!supportedMimeType) {
      setError("Formato de áudio não suportado para gravação.");
      toast({ title: "Erro de Gravação", description: "Formato de áudio não suportado.", variant: "destructive" });
      return false;
    }

    audioChunksRef.current = [];
    console.log("[Client] audioChunksRef limpo no início de startMediaRecorder.");

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        console.warn("[Client] MediaRecorder existente encontrado. Parando trilhas antigas e MR.");
        if (mediaRecorderRef.current.stream) {
          mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
        if (mediaRecorderRef.current.state === "recording") {
            try { mediaRecorderRef.current.stop(); } catch(e) {console.warn("Erro ao parar MR antigo em startMediaRecorder", e)}
        }
        mediaRecorderRef.current = null;
    }

    if (systemAudioStreamRef.current) {
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
        console.log("[Client] systemAudioStreamRef anterior limpo.");
    }


    let stream: MediaStream;
    try {
      if (audioInputMode === "system") {
        console.log("[Client] Tentando capturar áudio da tela/aba.");
        // @ts-ignore
        const displayStream = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: {
            // @ts-ignore
            suppressLocalAudioPlayback: false
          },
          // @ts-ignore
          preferCurrentTab: true,
        });

        const audioTracks = displayStream.getAudioTracks();
        if (audioTracks.length === 0) {
            setError("Nenhuma faixa de áudio encontrada na fonte de tela/aba selecionada.");
            toast({ title: "Erro de Captura", description: "A fonte selecionada não forneceu áudio.", variant: "destructive" });
            displayStream.getVideoTracks().forEach(track => track.stop());
            return false;
        }

        systemAudioStreamRef.current = displayStream;
        stream = new MediaStream(audioTracks);
        displayStream.getVideoTracks().forEach(track => track.stop());
        console.log("[Client] Áudio da tela/aba capturado. Faixas de vídeo paradas.");

      } else {
        console.log("[Client] Tentando capturar áudio do microfone.");
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      console.log(`[Client] Novo MediaRecorder criado para modo: ${audioInputMode}.`);

      mediaRecorderRef.current.ondataavailable = (event: any) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
           console.log(`[Client] MediaRecorder.ondataavailable: chunk adicionado. Total chunks: ${audioChunksRef.current.length}, tamanho do chunk: ${event.data.size}`);
        }
      };

      mediaRecorderRef.current.onstop = null;

      mediaRecorderRef.current.start(1000);
      console.log("[Client] MediaRecorder iniciado com timeslice 1000ms.");
      return true;
    } catch (err: any) {
      console.error(`[Client] Erro ao iniciar MediaRecorder (modo ${audioInputMode}):`, err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
         setError(audioInputMode === "system" ? "Permissão para captura de tela/aba negada." : "Permissão do microfone negada.");
         toast({ title: "Permissão Negada", description: audioInputMode === "system" ? "Você precisa permitir a captura de tela/aba." : "Você precisa permitir o acesso ao microfone.", variant: "destructive" });
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError"){
         setError(audioInputMode === "system" ? "Nenhuma fonte de captura de tela/aba encontrada." : "Nenhum microfone encontrado.");
         toast({ title: "Dispositivo Não Encontrado", description: audioInputMode === "system" ? "Não foi possível encontrar uma fonte de captura." : "Nenhum microfone detectado.", variant: "destructive" });
      } else {
         setError(audioInputMode === "system" ? "Falha ao iniciar captura de tela/aba." : "Falha ao acessar o microfone para gravação.");
         toast({ title: "Erro de Captura", description: audioInputMode === "system" ? "Não foi possível iniciar a captura de tela/aba." : "Não foi possível iniciar a gravação de áudio.", variant: "destructive" });
      }
      if(streamingStateRef.current !== "error") setStreamingState("error");
      if (systemAudioStreamRef.current) {
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
      }
      return false;
    }
  }, [supportedMimeType, toast, audioInputMode]);


  const sendDataToServer = useCallback(async (text: string) => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
      console.warn("[Client] WebSocket não está aberto. Tentando reconectar e enviar.");
      connectWebSocket(); // Esta função não é async, então a conexão é iniciada, mas não esperamos aqui.
      // Adiciona uma pequena espera para a conexão ser estabelecida antes de tentar enviar.
      // Isso é uma heurística e pode ser melhorado com um sistema de fila ou aguardando o onopen.
      await new Promise(resolve => setTimeout(resolve, 500));
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

    audioChunksRef.current = [];
    console.log("[Client] audioChunksRef limpo em sendDataToServer (após criar blob).");

    if (text.trim() || (blobToActuallySend && blobToActuallySend.size > 0)) {
      setIsTranslating(true);
      const reader = new FileReader();
      reader.onloadend = async () => {
        const audioDataUri = reader.result as string;
        console.log(`[Client] Enviando texto: "${text.substring(0,30)}..." e áudio (${(blobToActuallySend ? blobToActuallySend.size / 1024 : 0).toFixed(2)} KB).`);
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
      if (blobToActuallySend) {
        reader.readAsDataURL(blobToActuallySend);
      } else {
         console.log(`[Client] Enviando texto: "${text.substring(0,30)}..." sem áudio.`);
         if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
              action: "process_speech",
              transcribedText: text,
              sourceLanguage: sourceLanguage,
              targetLanguage: targetLanguage,
              audioDataUri: null
            }));
          } else {
            console.warn("[Client] WebSocket fechou antes do envio de texto sem áudio.");
            setError("Conexão perdida antes do envio. Tente novamente.");
            setIsTranslating(false);
          }
      }
    } else {
      console.warn(`[Client] Não enviando (sendDataToServer): Texto vazio OU Blob de áudio nulo/vazio (tamanho: ${blobToActuallySend?.size ?? 0}) para texto: "${text.substring(0,30)}..."`);
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
      recognition.onend = null;
      try { recognition.abort(); } catch (e) { console.warn("[Client] Erro ao chamar recognition.abort():", e); }
      recognition = null;
    }

    if (mediaRecorderRef.current) {
      console.log("[Client] MR: Limpando handlers e parando em stopRecognitionInternals. Estado atual:", mediaRecorderRef.current.state);
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.ondataavailable = null;
      if (mediaRecorderRef.current.stream) {
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
      if (mediaRecorderRef.current.state === "recording") {
        try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Erro ao parar MR em stopRecInternals (gravando)", e);}
      }
      mediaRecorderRef.current = null;
    }

    if (systemAudioStreamRef.current) {
        console.log("[Client] Limpando systemAudioStreamRef em stopRecognitionInternals.");
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
    }

    audioChunksRef.current = [];
    accumulatedInterimRef.current = "";
    setInterimTranscribedText("");
    if (!isUnmounting && streamingStateRef.current !== "idle" && streamingStateRef.current !== "error") {
      setStreamingState("idle");
      console.log("[Client] stopRecognitionInternals: Estado definido para idle.");
    } else if (!isUnmounting) {
        console.log(`[Client] stopRecognitionInternals: Estado era ${streamingStateRef.current}, mantendo ${streamingStateRef.current}.`);
    }
  }, []);


  const startRecognition = useCallback(async () => {
    console.log(`[Client] Tentando iniciar/reiniciar reconhecimento (startRecognition). Estado atual: ${streamingStateRef.current} Idioma Fonte: ${sourceLanguage}, Modo Áudio: ${audioInputMode}`);

    setStreamingState("recognizing");
    // setTranscribedText(""); // Removido para manter histórico
    // setTranslatedText(""); // Removido para manter histórico

    if (!isSpeechRecognitionSupported()) { setError("Reconhecimento não suportado"); setStreamingState("error"); return; }
    if (!supportedMimeType) { setError("Formato de áudio não suportado"); setStreamingState("error"); return; }

    setInterimTranscribedText("");
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

    if (!error) setError(null); // Limpar erro apenas se não houver um erro atual que precise ser exibido

    const mediaRecorderStarted = await startMediaRecorder();
    if (!mediaRecorderStarted) {
      return;
    }

    if (streamingStateRef.current === "recognizing" && !error) { // Adicionado !error para evitar toast se já houver erro
        toast({ title: "Microfone Ativado", description: `Iniciando reconhecimento (microfone) e gravação (modo: ${audioInputMode})...` });
    }


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
                if (streamingStateRef.current === "recognizing" && recognition) {
                    console.log("[Client] onresult/MR.onstop: Reiniciando MediaRecorder e SR.");
                    await startMediaRecorder(); // Reinicia MR
                    if (typeof recognition.start === 'function') recognition.start(); // Reinicia SR
                } else if (recognition) {
                    recognition.stop();
                }
            };
            try { mediaRecorderRef.current.stop(); } catch(e) {
                console.warn("Erro ao parar MR para final transcript:", e);
                await sendDataToServer(finalTranscriptForThisSegment);
                if (streamingStateRef.current === "recognizing" && recognition) {
                    await startMediaRecorder();
                    if (typeof recognition.start === 'function') recognition.start();
                } else if (recognition) {
                    recognition.stop();
                }
            }
        } else {
            console.warn(`[Client] MediaRecorder não gravando ou nulo para final_transcript: "${finalTranscriptForThisSegment}". Estado: ${mediaRecorderRef.current?.state}. Chunks: ${audioChunksRef.current.length}.`);
            await sendDataToServer(finalTranscriptForThisSegment);
            if (streamingStateRef.current === "recognizing" && recognition) {
                 console.log("[Client] onresult/MR já parado: Reiniciando MediaRecorder e SR.");
                 await startMediaRecorder();
                 if (typeof recognition.start === 'function') recognition.start();
            } else if (recognition) {
                 recognition.stop();
            }
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
                     if (streamingStateRef.current === "recognizing" && recognition) {
                        console.log("[Client] endOfSpeechTimeout/MR.onstop: Reiniciando MediaRecorder e SR.");
                        await startMediaRecorder();
                        if (typeof recognition.start === 'function') recognition.start();
                    } else if (recognition) {
                        recognition.stop();
                    }
                };
                try { mediaRecorderRef.current.stop(); } catch(e) {
                    console.warn("Erro ao parar MR para timeout interino:", e);
                    await sendDataToServer(interimToProcess);
                    if (streamingStateRef.current === "recognizing" && recognition) {
                        await startMediaRecorder();
                        if (typeof recognition.start === 'function') recognition.start();
                    } else if (recognition) {
                        recognition.stop();
                    }
                }
            } else {
                console.warn(`[Client] MediaRecorder não gravando ou nulo para timeout interino: "${interimToProcess}". Estado: ${mediaRecorderRef.current?.state}.`);
                await sendDataToServer(interimToProcess);
                if (streamingStateRef.current === "recognizing" && recognition) {
                    console.log("[Client] endOfSpeechTimeout/MR já parado: Reiniciando MediaRecorder e SR.");
                    await startMediaRecorder();
                    if (typeof recognition.start === 'function') recognition.start();
                } else if (recognition) {
                    recognition.stop();
                }
            }
          }
        }, END_OF_SPEECH_TIMEOUT_MS);
      }
    };

    recognition.onerror = async (event: any) => {
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);
      console.error("[Client] Erro no SpeechRecognition:", event.error, event.message);

      if (event.error === 'no-speech' && streamingStateRef.current === "recognizing") {
        console.log("[Client] SR.onerror: Erro 'no-speech'. Tentando reiniciar via onend.");
        if (recognition) {
          recognition.stop(); // Isso acionará o onend.
        } else {
          // Caso improvável, mas tenta reiniciar diretamente.
          await startRecognition();
        }
        return; // Retorna aqui para evitar definir o estado como 'error' imediatamente.
      }

      let errMessage = `Erro no reconhecimento: ${event.error}`;
      const interimOnError = accumulatedInterimRef.current.trim();
      if (interimOnError && (event.error === 'network' || event.error === 'audio-capture')) {
          console.log(`[Client] Erro SR '${event.error}' com interino: "${interimOnError}". Processando como final e parando.`);
          setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimOnError);
          await sendDataToServer(interimOnError);
      }

      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        errMessage = "Permissão do microfone negada ou serviço não permitido.";
      } else if (event.error === 'language-not-supported') {
        errMessage = `Idioma '${recognition?.lang}' não suportado.`;
      } else if (event.error === 'aborted') {
        console.log("[Client] SpeechRecognition aborted. Isso é esperado ao parar intencionalmente ou para reiniciar.");
         if (streamingStateRef.current === "stopping" || streamingStateRef.current === "recognizing"){
            if(recognition) recognition.onend = null;
            stopRecognitionInternals();
            return;
        }
      }

      setError(errMessage);
      setStreamingState("error"); // Define o estado para error aqui para outros erros.

      if(recognition) {
        recognition.onend = null;
        if (typeof recognition.stop === 'function') recognition.stop();
      }
      stopRecognitionInternals();

      if (event.error !== 'no-speech' && event.error !== 'aborted') {
        toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
      }
    };

    recognition.onend = async () => {
      console.log(`[Client] SpeechRecognition.onend disparado. Estado atual (ref): ${streamingStateRef.current}`);
      if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

      if (streamingStateRef.current === "recognizing") {
        console.log("[Client] SR.onend: Estado é 'recognizing' (provavelmente após no-speech). Tentando reiniciar o ciclo...");
        await startRecognition();
      } else if (streamingStateRef.current === "stopping" || streamingStateRef.current === "error") {
        console.log(`[Client] SR.onend: Estado é '${streamingStateRef.current}'. Chamando stopRecognitionInternals para limpeza.`);
        stopRecognitionInternals();
      }
    };

    console.log("[Client] Chamando recognition.start()...");
    try {
      recognition.start();
    } catch (e: any) {
      console.error("[Client] Erro ao chamar recognition.start():", e);
      setError(`Erro ao iniciar reconhecimento: ${e.message}`);
      setStreamingState("error");
      if (recognition) { recognition.onend = null; if(typeof recognition.stop === 'function') recognition.stop(); }
      stopRecognitionInternals();
    }
  }, [isSpeechRecognitionSupported, supportedMimeType, sourceLanguage, sendDataToServer, stopRecognitionInternals, connectWebSocket, toast, startMediaRecorder, error, audioInputMode]);


  const stopRecognition = useCallback(async () => {
    console.log("[Client] Tentando parar reconhecimento (stopRecognition)... Estado atual (ref):", streamingStateRef.current);
    if (streamingStateRef.current === "idle" || streamingStateRef.current === "error") {
        console.log("[Client] Já está idle ou em erro. stopRecognition não fará nada a mais.");
        return;
    }
    if (streamingStateRef.current === "stopping") {
        console.log("[Client] Já está no processo de parada.");
        return;
    }

    setStreamingState("stopping");

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
                if (recognition && typeof recognition.stop === 'function') {
                    recognition.stop(); // Acionará onend que chamará stopRecognitionInternals.
                } else {
                    stopRecognitionInternals();
                }
            };
            try { mediaRecorderRef.current.stop(); } catch (e) {
                console.warn("Error stopping MR during stopRecognition for interim", e);
                await sendDataToServer(interimToProcessOnStop);
                if(recognition && typeof recognition.stop === 'function') {
                    recognition.stop();
                } else {
                    stopRecognitionInternals();
                }
            }
        } else {
           await sendDataToServer(interimToProcessOnStop);
           if (recognition && typeof recognition.stop === 'function') {
                recognition.stop();
            } else {
                stopRecognitionInternals();
            }
        }
    } else if (recognition && typeof recognition.stop === 'function') {
        console.log("[Client] stopRecognition: Sem interino. Chamando recognition.stop().");
        recognition.stop(); // Acionará onend que chamará stopRecognitionInternals.
    } else {
        console.log("[Client] stopRecognition: recognition é nulo. Chamando stopRecognitionInternals para garantir limpeza e estado idle.");
        stopRecognitionInternals();
    }
  }, [sendDataToServer, stopRecognitionInternals]);


  const handleToggleStreaming = () => {
    console.log("[Client] handleToggleStreaming chamado. Estado atual:", streamingState);
    if (streamingStateRef.current === "recognizing") {
      stopRecognition();
    } else if (streamingStateRef.current === "idle" || streamingStateRef.current === "error") {

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
    } else if (streamingStateRef.current === "stopping"){
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
                <AudioLines size={16}/>
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
              Selecione os idiomas e a fonte de áudio. A transcrição usa o microfone; a gravação usa a fonte selecionada.
              <br/>
              <span className="text-xs text-muted-foreground">
                Para capturar áudio de outra aba ou aplicativo (ex: Zoom, Meet), selecione "Tela/Aba".
                A seleção da aba/aplicativo é feita uma vez pelo diálogo do navegador. Para mudar a fonte de captura (outra aba/aplicativo),
                você precisará parar a transcrição atual e iniciá-la novamente para que o diálogo de seleção seja exibido.
                Transcrição via API Web Speech. Gravação via MediaRecorder. Tradução via servidor.
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6 items-end">
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
              <div className="flex flex-col space-y-2">
                <Label htmlFor="audio-input-mode" className="text-sm font-medium">Fonte do Áudio Gravado</Label>
                <RadioGroup
                  id="audio-input-mode"
                  value={audioInputMode}
                  onValueChange={(value: string) => {
                     if (streamingState !== "recognizing" && streamingState !== "stopping") {
                       setAudioInputMode(value as AudioInputMode);
                       console.log("[Client] Modo de entrada de áudio alterado para:", value);
                     }
                  }}
                  className="flex space-x-2"
                  disabled={streamingState === "recognizing" || streamingState === "stopping"}
                >
                  <div className="flex items-center space-x-1">
                    <RadioGroupItem value="microphone" id="mic-mode" />
                    <Label htmlFor="mic-mode" className="text-sm cursor-pointer"><Mic size={16} className="inline mr-1"/>Microfone</Label>
                  </div>
                  <div className="flex items-center space-x-1">
                    <RadioGroupItem value="system" id="system-mode" />
                    <Label htmlFor="system-mode" className="text-sm cursor-pointer"><ScreenShare size={16} className="inline mr-1"/>Tela/Aba</Label>
                  </div>
                </RadioGroup>
                {audioInputMode === "system" && <p className="text-xs text-muted-foreground">O áudio da tela/aba será gravado. A transcrição ainda usará o microfone.</p>}
              </div>
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
                    <p className="text-primary animate-pulse">Reconhecendo (microfone) e gravando (modo: {audioInputMode})...</p>
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
                  Transcrição (do Microfone):
                </h3>
                <Textarea
                  value={transcribedText + (interimTranscribedText ? (transcribedText ? " " : "") + interimTranscribedText : "")}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Texto transcrito"
                  placeholder={streamingState === "recognizing" ? "Ouvindo microfone..." : "A transcrição do microfone aparecerá aqui..."}
                />
              </div>
              <div>
                <h3 className="text-xl font-semibold font-headline mb-2 flex items-center gap-2">
                  <LanguagesIcon className="text-accent"/>
                  Tradução (do Microfone):
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
        <p className="mt-1">Transcrição local via API Web Speech (microfone). Gravação local via MediaRecorder (fonte selecionada). Tradução via servidor Genkit.</p>
      </footer>
    </div>
  );
}

    
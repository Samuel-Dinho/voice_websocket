
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
const MEDIA_RECORDER_TIMESLICE_MS = 1000; // How often MediaRecorder provides a chunk
const CHUNKS_TO_BUFFER_SYSTEM_AUDIO = 5; // Accumulate this many chunks before sending for system audio
let systemAudioSegmentCounter = 0;


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
  const audioInputModeRef = useRef(audioInputMode);
  useEffect(() => {
    audioInputModeRef.current = audioInputMode;
  }, [audioInputMode]);


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
       if (streamingStateRef.current !== "idle" && streamingStateRef.current !== "error" && event.code !== 1000) {
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
      stopInternals(true);
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
    if (audioInputMode === "microphone" && !isSpeechRecognitionSupported()) {
      setError("Reconhecimento de fala (microfone) não é suportado pelo seu navegador.");
      if (streamingStateRef.current !== 'error') setStreamingState("error");
      toast({
        title: "Navegador Incompatível",
        description: "Seu navegador não suporta a API Web Speech para transcrição via microfone.",
        variant: "destructive",
      });
    }
  }, [isSpeechRecognitionSupported, toast, audioInputMode]);


  const sendDataToServer = useCallback(async (text: string, audioBlobOverride?: Blob) => {
    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
      console.warn("[Client] WebSocket não está aberto. Tentando reconectar e enviar.");
      connectWebSocket();
      // Adiciona uma pequena espera para a reconexão ser estabelecida
      await new Promise(resolve => setTimeout(resolve, 500)); // 500ms de espera
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

    let blobToActuallySend: Blob | null = audioBlobOverride || null;
    
    // No modo microfone, se não houver override de blob, criamos um a partir dos chunks existentes.
    // O modo system sempre fornecerá um audioBlobOverride para seus envios periódicos ou finais.
    if (!blobToActuallySend && audioInputModeRef.current === "microphone" && audioChunksRef.current.length > 0) {
        blobToActuallySend = new Blob(audioChunksRef.current, { type: supportedMimeType! });
        console.log(`[Client] sendDataToServer (mic): Criado Blob de ${audioChunksRef.current.length} chunks, tamanho: ${blobToActuallySend.size} bytes para o texto "${text.substring(0,30)}..."`);
        audioChunksRef.current = []; // Limpa após criar o blob para este segmento
    } else if (audioBlobOverride) {
        console.log(`[Client] sendDataToServer (system/override): Usando Blob fornecido. Tamanho: ${audioBlobOverride.size} bytes para o texto "${text.substring(0,30)}..."`);
    }


    const textToSend = text; 

    if (textToSend.trim() || (blobToActuallySend && blobToActuallySend.size > 0)) {
      setIsTranslating(true);
      const reader = new FileReader();

      reader.onloadend = async () => {
        const audioDataUri = blobToActuallySend ? reader.result as string : null;
        const logAudioSize = audioDataUri ? (blobToActuallySend!.size / 1024).toFixed(2) + " KB" : "sem áudio";
        console.log(`[Client] Enviando (sendDataToServer): Texto: "${textToSend.substring(0,50)}...", Áudio: ${logAudioSize}, Modo: ${audioInputModeRef.current}`);
        
        if (ws.current && ws.current.readyState === WebSocket.OPEN) {
          ws.current.send(JSON.stringify({
            action: "process_speech",
            transcribedText: textToSend, 
            sourceLanguage: sourceLanguage,
            targetLanguage: targetLanguage,
            audioDataUri: audioDataUri,
            audioSourceMode: audioInputModeRef.current 
          }));
        } else {
          console.warn("[Client] WebSocket fechou antes do envio (sendDataToServer).");
          setError("Conexão perdida antes do envio. Tente novamente.");
          setIsTranslating(false);
        }
      };
      reader.onerror = async () => {
        console.error("[Client] Erro ao ler Blob como Data URI (sendDataToServer).");
        setIsTranslating(false);
        setError("Erro ao processar áudio para envio.");
      };

      if (blobToActuallySend && blobToActuallySend.size > 0) {
        reader.readAsDataURL(blobToActuallySend);
      } else { 
         // Envio apenas de texto (se houver texto e nenhum blob)
         console.log(`[Client] Enviando (sendDataToServer) apenas texto: "${textToSend.substring(0,50)}...". Modo: ${audioInputModeRef.current}`);
         if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            ws.current.send(JSON.stringify({
              action: "process_speech",
              transcribedText: textToSend,
              sourceLanguage: sourceLanguage,
              targetLanguage: targetLanguage,
              audioDataUri: null, // Sem URI de áudio
              audioSourceMode: audioInputModeRef.current
            }));
          } else {
            console.warn("[Client] WebSocket fechou antes do envio de texto (sendDataToServer).");
            setError("Conexão perdida antes do envio. Tente novamente.");
            setIsTranslating(false);
          }
      }
    } else {
      console.warn(`[Client] Não enviando (sendDataToServer): Texto vazio E Blob de áudio nulo/vazio para texto: "${textToSend.substring(0,30)}..."`);
      setIsTranslating(false); 
    }
  }, [supportedMimeType, sourceLanguage, targetLanguage, connectWebSocket]);


  const startMediaRecorder = useCallback(async (): Promise<boolean> => {
    console.log("[Client] Iniciando startMediaRecorder");
    if (!supportedMimeType) {
      setError("Formato de áudio não suportado para gravação.");
      toast({ title: "Erro de Gravação", description: "Formato de áudio não suportado.", variant: "destructive" });
      return false;
    }
    
    audioChunksRef.current = []; 
    systemAudioSegmentCounter = 0; // Reset counter for system audio segments
    console.log("[Client] audioChunksRef e systemAudioSegmentCounter resetados no início de startMediaRecorder.");

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

    let stream: MediaStream;
    try {
      if (audioInputModeRef.current === "system") {
        const hasActiveSystemStream = systemAudioStreamRef.current && systemAudioStreamRef.current.getAudioTracks().some(track => track.readyState === 'live');

        if (hasActiveSystemStream) {
            console.log("[Client] Reutilizando systemAudioStream existente.");
            stream = systemAudioStreamRef.current!;
        } else {
            console.log(`[Client] systemAudioStream ${systemAudioStreamRef.current ? 'existente mas inativo' : 'inexistente'}. Tentando capturar áudio da tela/aba (novo stream).`);
            if (systemAudioStreamRef.current) {
                systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
                systemAudioStreamRef.current = null;
            }
            
            const displayStream = await navigator.mediaDevices.getDisplayMedia({
              video: true, 
              audio: {
                // @ts-ignore 
                suppressLocalAudioPlayback: false 
              },
            });

            const audioTracks = displayStream.getAudioTracks();
            if (audioTracks.length > 0) {
                stream = new MediaStream(audioTracks); 
                displayStream.getVideoTracks().forEach(track => track.stop()); 
                systemAudioStreamRef.current = displayStream; 
                console.log("[Client] Áudio da tela/aba capturado. Faixas de vídeo paradas. systemAudioStreamRef armazena o displayStream original.");
            } else {
                setError("Nenhuma faixa de áudio encontrada na fonte de tela/aba selecionada. Certifique-se de que a aba/aplicativo está reproduzindo som e que você permitiu o compartilhamento de áudio.");
                toast({ title: "Erro de Captura de Áudio", description: "A fonte selecionada não forneceu áudio ou o compartilhamento de áudio não foi permitido.", variant: "destructive" });
                displayStream.getTracks().forEach(track => track.stop()); 
                return false;
            }
        }
      } else { // Microphone mode
        console.log("[Client] Tentando capturar áudio do microfone.");
         if (systemAudioStreamRef.current) { 
            systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
            systemAudioStreamRef.current = null;
        }
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      }

      mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: supportedMimeType });
      console.log(`[Client] Novo MediaRecorder criado para modo: ${audioInputModeRef.current}. MimeType: ${supportedMimeType}. Stream ID: ${stream.id}`);

      mediaRecorderRef.current.ondataavailable = async (event: BlobEvent) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          // console.log(`[Client] MR.ondataavailable: chunk adicionado. Total chunks: ${audioChunksRef.current.length}, Tamanho do chunk: ${event.data.size}, Modo: ${audioInputModeRef.current}`);
          
          if (audioInputModeRef.current === "system" && audioChunksRef.current.length >= CHUNKS_TO_BUFFER_SYSTEM_AUDIO) {
            const chunksToSend = [...audioChunksRef.current]; 
            audioChunksRef.current = []; // Limpa o buffer para o próximo lote ANTES de enviar async
            const systemAudioSegmentBlob = new Blob(chunksToSend, { type: supportedMimeType! });
            systemAudioSegmentCounter++;
            const segmentText = `[System Audio Segment ${systemAudioSegmentCounter} - ${new Date().toLocaleTimeString()}]`;
            console.log(`[Client] Modo Sistema: Enviando ${chunksToSend.length} chunks acumulados. Tamanho do Blob: ${systemAudioSegmentBlob.size}. Texto: ${segmentText}`);
            await sendDataToServer(segmentText, systemAudioSegmentBlob);
          }
        }
      };
      
      mediaRecorderRef.current.onstop = async () => { 
        console.log(`[Client] MR.onstop (gravação completa) para modo ${audioInputModeRef.current}. Chunks restantes: ${audioChunksRef.current.length}`);
        
        // Para modo "system", envia quaisquer chunks finais remanescentes
        if (audioInputModeRef.current === "system" && audioChunksRef.current.length > 0) {
            const finalChunks = [...audioChunksRef.current];
            audioChunksRef.current = []; // Limpa o buffer
            const finalSystemAudioBlob = new Blob(finalChunks, { type: supportedMimeType! });
            systemAudioSegmentCounter++;
            const finalText = `[Final System Audio Segment ${systemAudioSegmentCounter} - ${new Date().toLocaleTimeString()}]`;
            console.log(`[Client] Modo Sistema (onstop): Enviando ${finalChunks.length} chunks finais. Tamanho do Blob: ${finalSystemAudioBlob.size}. Texto: ${finalText}`);
            await sendDataToServer(finalText, finalSystemAudioBlob);
        }
        // Para modo "microphone", o sendDataToServer geralmente é chamado por SpeechRecognition.
        // No entanto, se SpeechRecognition não estiver ativo e MR parar, enviamos o que tivermos.
        else if (audioInputModeRef.current === "microphone" && audioChunksRef.current.length > 0 && !recognition) { 
            const finalMicChunks = [...audioChunksRef.current];
            audioChunksRef.current = [];
            const finalMicAudioBlob = new Blob(finalMicChunks, {type: supportedMimeType!});
            const finalMicText = transcribedText ? transcribedText.split(" ").pop() || "[Mic Audio Segment]" : "[Mic Audio Segment]";
            console.log(`[Client] Modo Microfone (onstop MR, sem SR ativo): Enviando ${finalMicChunks.length} chunks finais. Tamanho do Blob: ${finalMicAudioBlob.size}. Texto: ${finalMicText}`);
            await sendDataToServer(finalMicText, finalMicAudioBlob);
        }

        // Limpeza das trilhas do stream
        if (mediaRecorderRef.current?.stream) {
            mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
        }
        if (audioInputModeRef.current === "system" && systemAudioStreamRef.current) {
           console.log("[Client] MR.onstop (system): Parando trilhas do systemAudioStreamRef.");
           systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
           systemAudioStreamRef.current = null; 
        }
        // Importante: não defina mediaRecorderRef.current.onstop = null aqui, pois stopInternals pode precisar dele.
      }; 

      if (audioInputModeRef.current === "system") {
        mediaRecorderRef.current.start(MEDIA_RECORDER_TIMESLICE_MS);
        console.log(`[Client] MediaRecorder (system) iniciado com timeslice ${MEDIA_RECORDER_TIMESLICE_MS}ms.`);
      } else { // microphone mode
        mediaRecorderRef.current.start(); 
        console.log(`[Client] MediaRecorder (mic) iniciado (sem timeslice).`);
      }
      return true;

    } catch (err: any) {
      console.error(`[Client] Erro ao iniciar MediaRecorder (modo ${audioInputModeRef.current}):`, err);
      if (err.name === "NotAllowedError" || err.name === "PermissionDeniedError") {
         setError(audioInputModeRef.current === "system" ? "Permissão para captura de tela/aba negada." : "Permissão do microfone negada.");
         toast({ title: "Permissão Negada", description: audioInputModeRef.current === "system" ? "Você precisa permitir a captura de tela/aba." : "Você precisa permitir o acesso ao microfone.", variant: "destructive" });
      } else if (err.name === "NotFoundError" || err.name === "DevicesNotFoundError"){
         setError(audioInputModeRef.current === "system" ? "Nenhuma fonte de captura de tela/aba encontrada." : "Nenhum microfone encontrado.");
         toast({ title: "Dispositivo Não Encontrado", description: audioInputModeRef.current === "system" ? "Não foi possível encontrar uma fonte de captura." : "Nenhum microfone detectado.", variant: "destructive" });
      } else if (err.name === "AbortError") { 
        setError("Captura de tela/aba cancelada pelo usuário.");
      } else {
         setError(audioInputModeRef.current === "system" ? `Falha ao iniciar captura de tela/aba: ${err.message}` : `Falha ao acessar o microfone: ${err.message}`);
         toast({ title: "Erro de Captura", description: audioInputModeRef.current === "system" ? `Não foi possível iniciar a captura de tela/aba: ${err.message}` : `Não foi possível iniciar a gravação de áudio: ${err.message}`, variant: "destructive" });
      }
      if(streamingStateRef.current !== "error" && err.name !== "AbortError") setStreamingState("error");
      
      if (systemAudioStreamRef.current && audioInputModeRef.current === "system") {
        systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
        systemAudioStreamRef.current = null;
      }
      return false;
    }
  }, [supportedMimeType, toast, sendDataToServer, transcribedText]);


  const stopInternals = useCallback((isUnmounting = false) => {
    console.log("[Client] Chamando stopInternals.", { isUnmounting, currentState: streamingStateRef.current });
    if (endOfSpeechTimerRef.current) {
      clearTimeout(endOfSpeechTimerRef.current);
      endOfSpeechTimerRef.current = null;
    }

    if (recognition) {
      console.log("[Client] SR: Limpando handlers e abortando em stopInternals.");
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onstart = null;
      recognition.onend = null;
      try { recognition.abort(); } catch (e) { console.warn("[Client] Erro ao chamar recognition.abort():", e); }
      recognition = null;
    }

    if (mediaRecorderRef.current) {
      console.log("[Client] MR: Limpando handlers e parando em stopInternals. Estado atual:", mediaRecorderRef.current.state);
      // Deixa o onstop original anexado em startMediaRecorder para lidar com o envio final de chunks
      // mediaRecorderRef.current.onstop = null; 
      mediaRecorderRef.current.ondataavailable = null; 
      
      if (audioInputModeRef.current === "microphone" && mediaRecorderRef.current.stream && !isUnmounting) {
        mediaRecorderRef.current.stream.getTracks().forEach(track => track.stop());
      }
      // Para system audio, o stream (systemAudioStreamRef) é parado no onstop do MR ou aqui se não for desmontagem.
      if (audioInputModeRef.current === "system" && systemAudioStreamRef.current && !isUnmounting) {
          console.log("[Client] Limpando systemAudioStreamRef em stopInternals (não desmontando).");
          systemAudioStreamRef.current.getTracks().forEach(track => track.stop());
          systemAudioStreamRef.current = null;
      }

      if (mediaRecorderRef.current.state === "recording") {
        try { mediaRecorderRef.current.stop(); } catch (e) { console.warn("Erro ao parar MR em stopInternals (gravando)", e);}
      }
      mediaRecorderRef.current = null;
    }

    audioChunksRef.current = []; 
    accumulatedInterimRef.current = "";
    setInterimTranscribedText("");

    if (!isUnmounting && streamingStateRef.current !== "idle" && streamingStateRef.current !== "error") {
      setStreamingState("idle");
      console.log("[Client] stopInternals: Estado definido para idle.");
    } else if (!isUnmounting) {
        console.log(`[Client] stopInternals: Estado era ${streamingStateRef.current}, mantendo ${streamingStateRef.current} ou desmontando.`);
    }
  }, []);


  const startTranscriptionCycle = useCallback(async () => {
    console.log(`[Client] Tentando iniciar/reiniciar ciclo de transcrição. Estado atual: ${streamingStateRef.current} Idioma Fonte: ${sourceLanguage}, Modo Áudio: ${audioInputModeRef.current}`);

    setStreamingState("recognizing"); 

    if (audioInputModeRef.current === "microphone" && !isSpeechRecognitionSupported()) { setError("Reconhecimento de fala (microfone) não suportado"); setStreamingState("error"); return; }
    if (!supportedMimeType) { setError("Formato de áudio não suportado"); setStreamingState("error"); return; }

    setInterimTranscribedText("");
    accumulatedInterimRef.current = "";
    if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

    if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        console.log("[Client] WebSocket não conectado em startTranscriptionCycle. Tentando reconectar...");
        connectWebSocket();
        await new Promise(resolve => setTimeout(resolve, 500));
        if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
            setError("Falha ao conectar ao WebSocket para iniciar.");
            toast({ title: "Erro de Conexão", description: "Servidor WebSocket indisponível.", variant: "destructive" });
            setStreamingState("error");
            return;
        }
    }

    if (error) setError(null); // Limpa erro anterior ao tentar iniciar

    const mediaRecorderStarted = await startMediaRecorder();
    if (!mediaRecorderStarted) {
      // Se startMediaRecorder retornou false, o erro já foi setado e toast mostrado lá.
      // Apenas garante que o estado seja 'error' ou 'idle' se foi cancelado.
      if (error?.includes("cancelada pelo usuário")) {
        setStreamingState("idle");
      } else if (streamingStateRef.current !== "error") {
         setStreamingState("error");
      }
      return;
    }
    
    if (streamingStateRef.current === "recognizing" && !error) { // Só mostra toast de sucesso se não houve erro no MR
        toast({ title: audioInputModeRef.current === "microphone" ? "Microfone Ativado" : "Captura de Tela/Aba Ativada", description: `Iniciando gravação (modo: ${audioInputModeRef.current})...` });
    }


    if (audioInputModeRef.current === "microphone") {
      console.log("[Client] Modo Microfone: Configurando SpeechRecognition.");
      const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
      if (!SpeechRecognitionAPI) { setError("API SpeechRecognition não encontrada"); stopInternals(); setStreamingState("error"); return; }

      if (recognition && typeof recognition.stop === 'function') {
          console.warn("[Client] Instância de Recognition pré-existente encontrada. Abortando-a.");
          recognition.onresult = null; recognition.onerror = null; recognition.onstart = null; recognition.onend = null;
          try { recognition.abort(); } catch(e) { console.warn("[Client] Erro ao abortar SR pre-existente", e); }
          recognition = null;
      }
      try {
        recognition = new SpeechRecognitionAPI();
      } catch (e: any) { setError(`Erro ao criar SpeechRecognition: ${e.message}`); stopInternals(); setStreamingState("error"); return; }

      recognition.continuous = true;
      recognition.interimResults = true;
      const speechLang = sourceLanguage === "en" ? "en-US" : sourceLanguage === "es" ? "es-ES" : sourceLanguage === "fr" ? "fr-FR" : sourceLanguage === "de" ? "de-DE" : sourceLanguage === "it" ? "it-IT" : sourceLanguage === "pt" ? "pt-BR" : sourceLanguage;
      recognition.lang = speechLang;
      console.log(`[Client] Instância SpeechRecognition criada/recriada. Idioma: ${recognition.lang}`);

      recognition.onresult = async (event: any) => {
        if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);
        let finalTranscriptForThisSegment = "";
        let currentEventInterimTranscript = "";
        for (let i = event.resultIndex; i < event.results.length; ++i) {
          const transcriptPart = event.results[i][0].transcript;
          if (event.results[i].isFinal) { finalTranscriptForThisSegment += transcriptPart; } else { currentEventInterimTranscript += transcriptPart; }
        }
        finalTranscriptForThisSegment = finalTranscriptForThisSegment.trim();

        if (finalTranscriptForThisSegment) {
          console.log(`[Client] SR: Texto final de segmento: "${finalTranscriptForThisSegment}"`);
          setTranscribedText(prev => (prev ? prev.trim() + " " : "") + finalTranscriptForThisSegment);
          setInterimTranscribedText(""); accumulatedInterimRef.current = "";
          
          if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
              mediaRecorderRef.current.onstop = async () => { 
                  console.log(`[Client] MR.onstop (para final_transcript SR): "${finalTranscriptForThisSegment}"`);
                  if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null; // Evitar loops se stop for chamado de novo
                  
                  const audioBlob = new Blob(audioChunksRef.current, { type: supportedMimeType! });
                  audioChunksRef.current = []; 
                  await sendDataToServer(finalTranscriptForThisSegment, audioBlob); 
                  
                  if (streamingStateRef.current === "recognizing") { await startTranscriptionCycle(); } 
                  else if (recognition && typeof recognition.stop === 'function') { recognition.stop(); }
              };
              try { mediaRecorderRef.current.stop(); } catch(e) { 
                  console.warn("Erro ao parar MR para final_transcript SR:", e);
                  if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                  const audioBlob = new Blob(audioChunksRef.current, { type: supportedMimeType! });
                  audioChunksRef.current = [];
                  await sendDataToServer(finalTranscriptForThisSegment, audioBlob); 
                  if (streamingStateRef.current === "recognizing") { await startTranscriptionCycle(); } 
                  else if (recognition && typeof recognition.stop === 'function') { recognition.stop(); }
              }
          } else {
              console.warn(`[Client] MR não gravando ou nulo para final_transcript SR: "${finalTranscriptForThisSegment}".`);
              await sendDataToServer(finalTranscriptForThisSegment); 
              if (streamingStateRef.current === "recognizing") { await startTranscriptionCycle(); } 
              else if (recognition && typeof recognition.stop === 'function') { recognition.stop(); }
          }
        } else if (currentEventInterimTranscript) {
          accumulatedInterimRef.current = currentEventInterimTranscript;
          setInterimTranscribedText(accumulatedInterimRef.current);
          endOfSpeechTimerRef.current = setTimeout(async () => {
            const interimToProcess = accumulatedInterimRef.current.trim();
            accumulatedInterimRef.current = ""; setInterimTranscribedText("");
            if (interimToProcess && streamingStateRef.current === "recognizing") {
              console.log(`[Client] SR: Timeout, processando interino: "${interimToProcess}"`);
              setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimToProcess);
              if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                  mediaRecorderRef.current.onstop = async () => {
                      console.log(`[Client] MR.onstop (para timeout interino SR): "${interimToProcess}"`);
                      if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null; 
                      const audioBlob = new Blob(audioChunksRef.current, { type: supportedMimeType! });
                      audioChunksRef.current = [];
                      await sendDataToServer(interimToProcess, audioBlob); 
                      if (streamingStateRef.current === "recognizing") { await startTranscriptionCycle(); } 
                      else if (recognition && typeof recognition.stop === 'function') { recognition.stop(); }
                  };
                  try { mediaRecorderRef.current.stop(); } catch(e) {
                      console.warn("Erro ao parar MR para timeout interino SR:", e);
                       if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                      const audioBlob = new Blob(audioChunksRef.current, { type: supportedMimeType! });
                      audioChunksRef.current = [];
                      await sendDataToServer(interimToProcess, audioBlob); 
                      if (streamingStateRef.current === "recognizing") { await startTranscriptionCycle(); } 
                      else if (recognition && typeof recognition.stop === 'function') { recognition.stop(); }
                  }
              } else {
                  console.warn(`[Client] MR não gravando ou nulo para timeout interino SR: "${interimToProcess}".`);
                  await sendDataToServer(interimToProcess); 
                  if (streamingStateRef.current === "recognizing") { await startTranscriptionCycle(); } 
                  else if (recognition && typeof recognition.stop === 'function') { recognition.stop(); }
              }
            }
          }, END_OF_SPEECH_TIMEOUT_MS);
        }
      };

      recognition.onerror = async (event: any) => {
        if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);
        console.error("[Client] Erro no SpeechRecognition:", event.error, event.message);

        if (event.error === 'no-speech' && streamingStateRef.current === "recognizing") {
          console.log("[Client] SR.onerror: Erro 'no-speech'. Recognition.stop() será chamado, e onend deve reiniciar.");
          if (recognition) { recognition.stop(); } 
          return; 
        }

        let errMessage = `Erro no reconhecimento: ${event.error}`;
        const interimOnError = accumulatedInterimRef.current.trim();
        if (interimOnError && (event.error === 'network' || event.error === 'audio-capture')) {
            console.log(`[Client] Erro SR '${event.error}' com interino: "${interimOnError}". Processando como final e parando.`);
            setTranscribedText(prev => (prev ? prev.trim() + " " : "") + interimOnError);
            if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
                mediaRecorderRef.current.onstop = async () => {
                     if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                     const audioBlob = new Blob(audioChunksRef.current, { type: supportedMimeType! }); 
                     audioChunksRef.current = [];
                     await sendDataToServer(interimOnError, audioBlob);
                     stopInternals(); setStreamingState("error"); 
                };
                try { mediaRecorderRef.current.stop(); } catch(e) { 
                    console.warn("Erro ao parar MR em SR.onerror (com interino):", e);
                    if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                    stopInternals(); setStreamingState("error"); 
                }
            } else {
                 await sendDataToServer(interimOnError); 
                 stopInternals(); setStreamingState("error");
            }
        }
        if (event.error === 'not-allowed' || event.error === 'service-not-allowed') { errMessage = "Permissão do microfone negada ou serviço não permitido."; }
        else if (event.error === 'language-not-supported') { errMessage = `Idioma '${recognition?.lang}' não suportado.`; }
        else if (event.error === 'aborted') {
          console.log("[Client] SpeechRecognition aborted. Estado:", streamingStateRef.current);
           if (recognition) { recognition.onend = null; } 
          if (streamingStateRef.current === "stopping") { 
                stopInternals(); 
                setStreamingState("idle"); 
          } else if (streamingStateRef.current === "recognizing") {
                setError(errMessage); setStreamingState("error"); stopInternals();
          }
          return; 
        }
        
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
            setError(errMessage); 
            setStreamingState("error");
            stopInternals(); 
            toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" }); 
        } else if (recognition && event.error === 'no-speech') { 
            console.log("[Client] SR.onerror: 'no-speech', onend deve lidar com o reinício se ainda estiver reconhecendo.");
        }
      };

      recognition.onend = async () => {
        console.log(`[Client] SpeechRecognition.onend disparado. Estado atual (ref): ${streamingStateRef.current}`);
        if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);
        
        if (streamingStateRef.current === "recognizing") {
          console.log("[Client] SR.onend: Estado é 'recognizing'. Reiniciando o ciclo (SR e MR)...");
          await startTranscriptionCycle();
        } else if (streamingStateRef.current === "stopping") {
          console.log(`[Client] SR.onend: Estado é 'stopping'. Chamando stopInternals e definindo para idle.`);
          stopInternals(); 
          setStreamingState("idle");
        } else if (streamingStateRef.current === "error") {
           console.log(`[Client] SR.onend: Estado é 'error'. Limpeza já deve ter ocorrido via SR.onerror.`);
        } else {
          console.log(`[Client] SR.onend: Estado é '${streamingStateRef.current}'. Não fazendo nada extra.`);
        }
      };

      console.log("[Client] Chamando recognition.start()...");
      try {
        recognition.start();
      } catch (e: any) {
        console.error("[Client] Erro ao chamar recognition.start():", e);
        if (e.name !== 'InvalidStateError') { 
            setError(`Erro ao iniciar reconhecimento: ${e.message}`); setStreamingState("error");
            if (recognition) { recognition.onend = null; if(typeof recognition.stop === 'function') recognition.stop(); }
            stopInternals();
        } else { 
            console.warn("[Client] Tentativa de iniciar recognition que já estava iniciado ou em estado inválido.");
        }
      }
    } else { // audioInputModeRef.current === "system"
      console.log("[Client] Modo Tela/Aba: Gravação de áudio (em chunks) iniciada. Chunks serão enviados periodicamente.");
      setTranscribedText(""); 
      setInterimTranscribedText(""); 
    }
  }, [isSpeechRecognitionSupported, supportedMimeType, sourceLanguage, sendDataToServer, stopInternals, connectWebSocket, toast, startMediaRecorder, error]);


  const stopTranscriptionCycle = useCallback(async () => {
    console.log("[Client] Tentando parar ciclo de transcrição (stopTranscriptionCycle)... Estado atual (ref):", streamingStateRef.current);
    if (streamingStateRef.current === "idle" || streamingStateRef.current === "error") {
        console.log("[Client] Já está idle ou em erro.");
        if(error && streamingStateRef.current === "idle") setError(null);
        return;
    }
    if (streamingStateRef.current === "stopping") {
        console.log("[Client] Já está no processo de parada.");
        return;
    }

    setStreamingState("stopping"); 

    if (endOfSpeechTimerRef.current) clearTimeout(endOfSpeechTimerRef.current);

    if (audioInputModeRef.current === "microphone") {
        let textToProcessOnStop = accumulatedInterimRef.current.trim();
        accumulatedInterimRef.current = ""; 
        setInterimTranscribedText("");
        if (textToProcessOnStop) {
            console.log(`[Client] Parando (mic). Processando texto interino final: "${textToProcessOnStop}"`);
            setTranscribedText(prev => (prev ? prev.trim() + " " : "") + textToProcessOnStop);
        } else {
            textToProcessOnStop = ""; 
        }
        
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            mediaRecorderRef.current.onstop = async () => {
                if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null; // Evitar loops
                console.log(`[Client] MR.onstop (mic, durante parada manual) para: "${textToProcessOnStop}" ou último transcrito.`);
                const audioBlob = new Blob(audioChunksRef.current, { type: supportedMimeType! });
                audioChunksRef.current = [];
                
                const finalMicText = textToProcessOnStop || (transcribedText ? transcribedText.split(" ").pop() || "" : "");
                if (finalMicText || audioBlob.size > 0) {
                    await sendDataToServer(finalMicText, audioBlob);
                }
                
                if (recognition && typeof recognition.stop === 'function') {
                    recognition.onend = () => { stopInternals(); setStreamingState("idle"); }; 
                    try { recognition.abort(); } catch(e){console.warn("Erro no recognition.abort em stop mic:", e); stopInternals(); setStreamingState("idle");}
                } else {
                    stopInternals(); setStreamingState("idle");
                }
            };
            try { mediaRecorderRef.current.stop(); } catch (e) {
                console.warn("Erro ao parar MR (mic) durante parada manual:", e);
                 if(mediaRecorderRef.current) mediaRecorderRef.current.onstop = null;
                const audioBlob = new Blob(audioChunksRef.current, { type: supportedMimeType! });
                audioChunksRef.current = [];
                const finalMicTextOnError = textToProcessOnStop || (transcribedText ? transcribedText.split(" ").pop() || "" : "");
                 if (finalMicTextOnError || audioBlob.size > 0) {
                    await sendDataToServer(finalMicTextOnError, audioBlob);
                 }
                if(recognition && typeof recognition.stop === 'function') {
                    recognition.onend = () => { stopInternals(); setStreamingState("idle"); };
                    try { recognition.abort(); } catch(e2){console.warn("Erro no recognition.abort em stop mic (MR error catch):", e2); stopInternals(); setStreamingState("idle");}
                } else {
                    stopInternals(); setStreamingState("idle");
                }
            }
        } else if (recognition && typeof recognition.stop === 'function') { 
             console.log("[Client] stopTranscriptionCycle (mic): MR não gravando. Chamando recognition.abort().");
             recognition.onend = () => { stopInternals(); setStreamingState("idle"); };
             try { recognition.abort(); } catch(e){console.warn("Erro no recognition.abort em stop mic (no MR):", e); stopInternals(); setStreamingState("idle");}
             if (textToProcessOnStop || transcribedText) { // Enviar apenas texto se houver
                await sendDataToServer(textToProcessOnStop || (transcribedText ? transcribedText.split(" ").pop() || "" : ""));
             }
        } else { 
            stopInternals(); setStreamingState("idle");
        }
    } else { // audioInputModeRef.current === "system"
        console.log("[Client] Parando (modo system).");
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === "recording") {
            // O MR.onstop configurado em startMediaRecorder já lida com o envio de chunks finais.
            // Apenas chamamos stop() aqui.
            try { mediaRecorderRef.current.stop(); } catch (e) {
                console.warn("Erro ao parar MR (system) durante parada manual:", e);
                // Tenta enviar chunks remanescentes manualmente se stop() falhar
                if (audioChunksRef.current.length > 0) {
                    const finalSystemChunksOnError = [...audioChunksRef.current];
                    audioChunksRef.current = [];
                    const finalSystemAudioBlobOnError = new Blob(finalSystemChunksOnError, { type: supportedMimeType! });
                    systemAudioSegmentCounter++;
                    await sendDataToServer(`[Final System Audio Segment ${systemAudioSegmentCounter} - MR Stop Error - ${new Date().toLocaleTimeString()}]`, finalSystemAudioBlobOnError);
                }
            }
        } else { 
            console.log("[Client] MR (system) já parado ou não iniciado.");
            if (audioChunksRef.current.length > 0) { // Enviar quaisquer chunks que possam ter ficado
                 const lingeringSystemChunks = [...audioChunksRef.current];
                 audioChunksRef.current = [];
                 const lingeringSystemBlob = new Blob(lingeringSystemChunks, { type: supportedMimeType! });
                 systemAudioSegmentCounter++;
                 await sendDataToServer(`[Lingering System Audio Found on Stop ${systemAudioSegmentCounter} - ${new Date().toLocaleTimeString()}]`, lingeringSystemBlob);
            }
        }
        // Após MR.stop() ser chamado (ou se não estava gravando), o onstop do MR cuidará da limpeza.
        // Define o estado para idle após um pequeno atraso para permitir que operações assíncronas no MR.onstop completem.
        setTimeout(() => {
            stopInternals(); 
            setStreamingState("idle");
        }, 250); // Pequeno atraso
    }
  }, [sendDataToServer, stopInternals, supportedMimeType, transcribedText, error]);


  const handleToggleStreaming = () => {
    console.log("[Client] handleToggleStreaming chamado. Estado atual:", streamingStateRef.current);
    if (streamingStateRef.current === "recognizing") {
      stopTranscriptionCycle();
    } else if (streamingStateRef.current === "idle" || streamingStateRef.current === "error") {
      if(error && streamingStateRef.current !== "error") setError(null); 
      setTranscribedText(""); 
      setTranslatedText("");
      audioChunksRef.current = []; 
      systemAudioSegmentCounter = 0; // Reseta o contador de segmentos ao iniciar

      if (!ws.current || ws.current.readyState !== WebSocket.OPEN) {
        console.log("[Client] WebSocket não conectado ou fechado. Tentando reconectar antes de iniciar...");
        connectWebSocket();
        setTimeout(() => { 
          if (ws.current && ws.current.readyState === WebSocket.OPEN) {
            startTranscriptionCycle();
          } else {
            setError("Falha ao conectar ao WebSocket. Não é possível iniciar.");
            toast({ title: "Erro de Conexão", description: "Não foi possível conectar ao servidor para iniciar.", variant: "destructive"});
            if (streamingStateRef.current !== 'error') setStreamingState("error");
          }
        }, 750); 
      } else {
        startTranscriptionCycle();
      }
    } else if (streamingStateRef.current === "stopping"){
        console.log("[Client] Atualmente parando, aguarde.");
        toast({title: "Aguarde", description: "Finalizando gravação atual..."})
    }
  };


  const StreamButtonIcon = streamingState === "recognizing" ? MicOff : Mic;
  let streamButtonText = audioInputMode === "microphone" ? "Iniciar Transcrição (Microfone)" : "Iniciar Gravação (Tela/Aba)";
  if (streamingState === "recognizing") streamButtonText = audioInputMode === "microphone" ? "Parar Transcrição" : "Parar Gravação";
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
              Configurações de Tradução
            </CardTitle>
            <CardDescription>
              Selecione os idiomas e a fonte do áudio.
              <br/>
              <span className="text-xs text-muted-foreground">
                <strong>Modo Microfone:</strong> Transcrição local (Web Speech API) e gravação de áudio. Segmentos de áudio são enviados ao final de cada frase detectada ou após um timeout.
                <br />
                <strong>Modo Tela/Aba:</strong> Grava o áudio da tela/aba. Segmentos de áudio (~{CHUNKS_TO_BUFFER_SYSTEM_AUDIO * MEDIA_RECORDER_TIMESLICE_MS / 1000}s) são enviados periodicamente ao servidor para transcrição (Whisper) e tradução.
                <strong className="text-primary"> Ao usar "Tela/Aba", certifique-se de que a opção "Compartilhar áudio da aba" ou "Compartilhar áudio do sistema" esteja marcada no diálogo do navegador.</strong> Para mudar a fonte, pare e reinicie.
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
                }}
                languages={languageSelectorItems}
                disabled={streamingState === "recognizing" || streamingState === "stopping"}
              />
              <div className="flex flex-col space-y-2">
                <Label htmlFor="audio-input-mode" className="text-sm font-medium">Fonte do Áudio</Label>
                <RadioGroup
                  id="audio-input-mode"
                  value={audioInputMode}
                  onValueChange={(value: string) => {
                     if (streamingState !== "recognizing" && streamingState !== "stopping") {
                       setAudioInputMode(value as AudioInputMode);
                       console.log("[Client] Modo de entrada de áudio alterado para:", value);
                       setTranscribedText("");
                       setTranslatedText("");
                       setInterimTranscribedText("");
                       accumulatedInterimRef.current = "";
                       audioChunksRef.current = [];
                       systemAudioSegmentCounter = 0;
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
                    <p className="text-destructive">Gravação de áudio não suportada.</p>
                  )}
                  {(streamingState === "recognizing") && !isTranslating && audioInputMode === "microphone" && (
                    <p className="text-primary animate-pulse">Reconhecendo (microfone) e gravando...</p>
                  )}
                  {(streamingState === "recognizing") && !isTranslating && audioInputMode === "system" && (
                    <p className="text-primary animate-pulse">Gravando áudio da tela/aba (enviando segmentos de ~{CHUNKS_TO_BUFFER_SYSTEM_AUDIO}s)...</p>
                  )}
                  {isTranslating && (
                    <p className="text-accent animate-pulse">Processando/Traduzindo segmento...</p>
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
                  {audioInputMode === "microphone" ? "Transcrição (do Microfone):" : "Transcrição (Microfone - Desativado)"}
                </h3>
                <Textarea
                  value={audioInputMode === "microphone" ? (transcribedText + (interimTranscribedText ? (transcribedText ? " " : "") + interimTranscribedText : "")) : "Transcrição do microfone desativada no modo Tela/Aba."}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Texto transcrito"
                  placeholder={
                    audioInputMode === "microphone"
                      ? (streamingState === "recognizing" ? "Ouvindo microfone..." : "A transcrição do microfone aparecerá aqui...")
                      : "A transcrição do áudio da tela/aba (processada no servidor) será adicionada à caixa de Tradução."
                  }
                  disabled={audioInputMode === "system"}
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
                  placeholder={isTranslating ? "Traduzindo segmento..." : (streamingState === "recognizing" && audioInputMode === "system" ? "Aguardando segmentos de áudio da tela/aba para traduzir..." : "A tradução aparecerá aqui...")}
                />
              </div>
            </div>
          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox. Todos os direitos reservados.</p>
        <p className="mt-1">
          Modo Microfone: Transcrição local (Web Speech), áudio enviado ao servidor.
          Modo Tela/Aba: Gravação local (MediaRecorder), segmentos de áudio enviados ao servidor para STT (Whisper) e Tradução (Genkit).
        </p>
      </footer>
    </div>
  );
}

    
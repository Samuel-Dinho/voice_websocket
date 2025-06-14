
"use client";

import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Volume2, WifiOff, Loader2, Mic, PlayCircle, AudioLines } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState, useCallback } from "react";

type ListenerState = "connecting" | "connected" | "disconnected" | "error";

export default function ListenerPage() {
  const ws = useRef<WebSocket | null>(null);
  const [listenerState, setListenerState] = useState<ListenerState>("connecting");
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const utteranceQueueRef = useRef<SpeechSynthesisUtterance[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [audioActivated, setAudioActivated] = useState(false);
  const voiceLoadFallbackIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const speakNextInQueueRef = useRef<() => void>(() => {});
  const lastSuccessfullyEnqueuedTextRef = useRef<string | null>(null);

  const getWebSocketUrl = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = process.env.NEXT_PUBLIC_WEBSOCKET_PORT || '3001';
    return `${protocol}//${window.location.hostname}:${wsPort}`;
  };

  const loadVoices = useCallback(() => {
    const voices = window.speechSynthesis.getVoices();
    if (voices.length > 0) {
      setAvailableVoices(voices);
      console.log(`[Listener] Vozes de síntese carregadas: ${voices.length}`, voices.map(v => ({name: v.name, lang: v.lang, default: v.default})));
      if (voiceLoadFallbackIntervalRef.current) {
        clearInterval(voiceLoadFallbackIntervalRef.current);
        voiceLoadFallbackIntervalRef.current = null;
        console.log("[Listener] Vozes carregadas, fallbackInterval limpo.");
      }
    } else {
      console.log("[Listener] Lista de vozes vazia, aguardando onvoiceschanged ou fallback.");
    }
  }, []);

  useEffect(() => {
    loadVoices();
    if (typeof window !== 'undefined' && window.speechSynthesis) {
        if (window.speechSynthesis.onvoiceschanged !== undefined) {
            window.speechSynthesis.onvoiceschanged = loadVoices;
        } else {
            console.warn("[Listener] onvoiceschanged não suportado. Usando fallback de intervalo para carregar vozes.");
            if (!voiceLoadFallbackIntervalRef.current) {
                voiceLoadFallbackIntervalRef.current = setInterval(() => {
                    if(window.speechSynthesis.getVoices().length === 0) {
                        console.log("[Listener] Fallback: tentando carregar vozes...");
                        loadVoices();
                    } else if (voiceLoadFallbackIntervalRef.current) {
                        console.log("[Listener] Vozes já carregadas (detectado no fallback), limpando fallbackInterval.");
                        clearInterval(voiceLoadFallbackIntervalRef.current);
                        voiceLoadFallbackIntervalRef.current = null;
                    }
                }, 1000);
            }
        }
    }
    return () => {
      if (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = null;
      }
      if (voiceLoadFallbackIntervalRef.current) {
        console.log("[Listener] Limpando fallbackIntervalId ao desmontar o efeito de voz.");
        clearInterval(voiceLoadFallbackIntervalRef.current);
        voiceLoadFallbackIntervalRef.current = null;
      }
    };
  }, [loadVoices]);

  const speakNextInQueue = useCallback(() => {
    console.log(`[Listener] speakNextInQueue chamado. Fila: ${utteranceQueueRef.current.length}, TTS Realmente Falando: ${window.speechSynthesis.speaking}, Nosso Estado isSpeaking: ${isSpeaking}, Audio Ativado: ${audioActivated}`);
    if (!audioActivated) {
        console.log("[Listener] Áudio não ativado. Não falando.");
        if (isSpeaking) setIsSpeaking(false);
        return;
    }
    if (window.speechSynthesis.speaking) {
        console.log("[Listener] SpeechSynthesis já está falando. Não iniciando nova utterance.");
        if (!isSpeaking) setIsSpeaking(true); 
        return;
    }
    if (utteranceQueueRef.current.length === 0) {
        console.log("[Listener] Fila de utterances vazia.");
        if (isSpeaking) setIsSpeaking(false);
        return;
    }
    const utterance = utteranceQueueRef.current.shift();
    if (utterance) {
      setIsSpeaking(true);
      const targetLangLC = utterance.lang.toLowerCase();
      const targetLangPrefixLC = targetLangLC.split('-')[0];
      console.log(`[Listener] Processando utterance: "${utterance.text.substring(0,30)}...", Lang: ${utterance.lang}`);
      if (availableVoices.length > 0) {
        let voice = availableVoices.find(v => v.lang.toLowerCase().startsWith(targetLangPrefixLC) && v.default === true);
        if (!voice) voice = availableVoices.find(v => v.lang.toLowerCase().startsWith(targetLangPrefixLC));
        if (!voice && targetLangLC !== targetLangPrefixLC) voice = availableVoices.find(v => v.lang.toLowerCase() === targetLangLC);
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang; // Use the voice's lang for potentially better compatibility
          console.log(`[Listener] Voz encontrada e definida: ${voice.name} (${voice.lang}) para o texto: "${utterance.text.substring(0,30)}..."`);
        } else {
          console.warn(`[Listener] Nenhuma voz específica encontrada para ${targetLangLC} (prefixo ${targetLangPrefixLC}). Usando padrão do navegador para ${utterance.lang}. Texto: "${utterance.text.substring(0,30)}..."`);
        }
      } else {
        console.warn(`[Listener] availableVoices está VAZIO no momento de tentar selecionar uma voz. Texto: "${utterance.text.substring(0,30)}..."`);
      }
      utterance.onstart = () => {
        console.log(`[Listener] Evento onstart: Síntese de fala iniciada para: "${utterance.text.substring(0,30)}..."`);
        setLastMessage(`Falando: "${utterance.text.substring(0,20)}..."`);
      };
      utterance.onend = () => {
        console.log(`[Listener] Evento onend: Síntese de fala finalizada para: "${utterance.text.substring(0,30)}..."`);
        setIsSpeaking(false);
        speakNextInQueueRef.current();
      };
      utterance.onerror = (event) => {
        console.error(`[Listener] Evento onerror: Erro na síntese de fala: ${event.error}. Texto: "${utterance.text.substring(0,30)}..." Detalhes:`, event);
        setLastMessage(`Erro ao falar: ${event.error}`);
        setIsSpeaking(false);
        speakNextInQueueRef.current();
      };
      console.log("[Listener] Chamando window.speechSynthesis.speak() com utterance:", {text: utterance.text, lang: utterance.lang, voice: utterance.voice?.name });
      try {
        window.speechSynthesis.speak(utterance);
      } catch (e) {
        console.error("[Listener] Erro direto ao chamar window.speechSynthesis.speak():", e);
        setIsSpeaking(false);
        speakNextInQueueRef.current();
      }
    } else {
      console.warn("[Listener] speakNextInQueue: utterance era nula ou fila ficou vazia inesperadamente.");
      if (isSpeaking) setIsSpeaking(false);
    }
  }, [audioActivated, isSpeaking, availableVoices, setIsSpeaking, setLastMessage]); 

  useEffect(() => {
    speakNextInQueueRef.current = speakNextInQueue;
  }, [speakNextInQueue]);

  const handleActivateAudio = useCallback(() => {
    setAudioActivated(true);
    setLastMessage("Áudio ativado pelo usuário. Aguardando traduções...");
    lastSuccessfullyEnqueuedTextRef.current = null; 
    console.log("[Listener] Áudio ativado pelo usuário. lastSuccessfullyEnqueuedTextRef resetado. Tentando utterance de desbloqueio.");
    try {
        if (typeof window !== 'undefined' && window.speechSynthesis && window.speechSynthesis.speaking) {
            window.speechSynthesis.cancel();
        }
        utteranceQueueRef.current = [];
        setIsSpeaking(false); 
        const unlockUtterance = new SpeechSynthesisUtterance(" ");
        unlockUtterance.volume = 0.01; // Make it silent
        // Try to find an English voice for broader compatibility of the unlock utterance
        const englishVoice = availableVoices.find(v => v.lang.toLowerCase().startsWith("en") && v.default) || availableVoices.find(v => v.lang.toLowerCase().startsWith("en"));
        unlockUtterance.lang = englishVoice ? englishVoice.lang : "en-US"; // Default to en-US if no specific English voice found
        if (englishVoice) unlockUtterance.voice = englishVoice;
        
        unlockUtterance.onstart = () => console.log("[Listener] Unlock utterance onstart.");
        unlockUtterance.onend = () => {
            console.log("[Listener] Unlock utterance onend.");
            setIsSpeaking(false); // Ensure isSpeaking is false after unlock
            speakNextInQueueRef.current(); // Try to speak anything that might have been queued
        };
        unlockUtterance.onerror = (event) => {
            console.error("[Listener] Unlock utterance onerror:", event.error, "Evento:", event);
            setIsSpeaking(false);
            speakNextInQueueRef.current();
        };
        window.speechSynthesis.speak(unlockUtterance);
    } catch (e) {
        console.error("[Listener] Erro ao tentar utterance de desbloqueio de áudio:", e);
        setIsSpeaking(false); // Ensure isSpeaking is false on error
        speakNextInQueueRef.current();
    }
  }, [availableVoices, setIsSpeaking]); // Added setIsSpeaking to dependencies

  useEffect(() => {
    console.log("[Listener] useEffect principal EXECUTANDO. Conectando WebSocket. lastSuccessfullyEnqueuedTextRef.current no início:", lastSuccessfullyEnqueuedTextRef.current);
    const WS_URL = getWebSocketUrl();
    setListenerState("connecting");

    if (ws.current && ws.current.readyState !== WebSocket.CLOSED) {
      console.warn("[Listener] WebSocket ref já existe e não está fechado. Fechando conexão anterior.");
      ws.current.onclose = null; ws.current.onerror = null; ws.current.onmessage = null; ws.current.onopen = null;
      ws.current.close(1000, "Reconexão iniciada por useEffect (pré-limpeza)");
      ws.current = null;
    }
    const newWs = new WebSocket(WS_URL);
    ws.current = newWs;

    newWs.onopen = () => {
      if (ws.current !== newWs) { console.log("[Listener] onopen: Conexão antiga, ignorando."); newWs.close(1000, "Stale onopen callback"); return; }
      console.log("[Listener] WebSocket conectado.");
      setListenerState("connected");
      setLastMessage("Conectado. Aguardando ativação de áudio se necessário.");
      lastSuccessfullyEnqueuedTextRef.current = null; // Reset on new connection
      console.log("[Listener] onopen: Resetando lastSuccessfullyEnqueuedTextRef.current para null.");
      newWs.send(JSON.stringify({ action: "subscribe_audio" }));
    };

    newWs.onmessage = (event) => {
      if (ws.current !== newWs) { console.log("[Listener] onmessage: Conexão antiga, ignorando mensagem."); return; }
      try {
        const serverMessage = JSON.parse(event.data as string);
        console.log("[Listener] Mensagem parseada recebida. Tipo:", serverMessage.type, "Conteúdo (primeiros 100 chars):", JSON.stringify(serverMessage).substring(0,100));
        
        if (serverMessage.type === "translated_text_for_listener" && serverMessage.text && serverMessage.targetLanguage) {
          const textToSpeak = serverMessage.text;
          // Normalize by trimming leading/trailing whitespace for comparison
          const normalizedTextToSpeak = textToSpeak.trim();
          const normalizedLastEnqueuedText = lastSuccessfullyEnqueuedTextRef.current ? lastSuccessfullyEnqueuedTextRef.current.trim() : null;

          console.log(`[Listener] Comparando texto recebido (normalizado: "${normalizedTextToSpeak.substring(0,30)}...") com lastSuccessfullyEnqueuedTextRef (normalizado: "${normalizedLastEnqueuedText ? normalizedLastEnqueuedText.substring(0,30) : 'null'}...")`);
          
          if (normalizedTextToSpeak && normalizedTextToSpeak === normalizedLastEnqueuedText) {
            console.log(`[Listener] Texto traduzido normalizado é o MESMO que o último enfileirado com sucesso. Ignorando para fala: "${normalizedTextToSpeak.substring(0,30)}..."`);
            setLastMessage(`Texto repetido ignorado: "${normalizedTextToSpeak.substring(0,20)}..." (${new Date().toLocaleTimeString()})`);
            return; // Do not enqueue or speak
          }
          
          setLastMessage(`Texto traduzido recebido para ${serverMessage.targetLanguage}: "${textToSpeak.substring(0,30)}..." (${new Date().toLocaleTimeString()})`);

          // Split into sentences to avoid very long utterances, if SpeechSynthesis supports it well.
          // This can be improved with more robust sentence splitting if needed.
          const sentences = textToSpeak.match(/[^.!?]+(?:[.!?]+["']?|$)/g) || [];
          if (sentences.length === 0 && textToSpeak.trim()) { // If no sentences found but text exists, treat as one sentence
            sentences.push(textToSpeak.trim());
          }
          
          let utterancesAddedCount = 0;
          sentences.forEach(sentence => {
            const trimmedSentence = sentence.trim();
            if (trimmedSentence) {
              const utterance = new SpeechSynthesisUtterance(trimmedSentence);
              utterance.lang = serverMessage.targetLanguage; // Set language for TTS
              utteranceQueueRef.current.push(utterance);
              utterancesAddedCount++;
            }
          });

          if (utterancesAddedCount > 0) {
            const previousRefValue = lastSuccessfullyEnqueuedTextRef.current;
            lastSuccessfullyEnqueuedTextRef.current = textToSpeak; // Store the original full text that was processed
            console.log(`[Listener] ${utterancesAddedCount} utterance(s) adicionada(s) à fila. lastSuccessfullyEnqueuedTextRef ATUALIZADO de "${previousRefValue ? previousRefValue.substring(0,30) : 'null'}" para "${textToSpeak.substring(0, 50)}...". Tamanho total da fila: ${utteranceQueueRef.current.length}`);
            speakNextInQueueRef.current();
          } else {
             console.warn(`[Listener] Nenhuma utterance adicionada à fila para o texto: "${textToSpeak.substring(0, 50)}..." (Sentenças detectadas: ${sentences.length})`);
          }

        } else if (serverMessage.message) {
          setLastMessage(serverMessage.message);
        } else if (serverMessage.error) {
           setLastMessage(`Erro do servidor: ${serverMessage.error}`);
           console.error("[Listener] Erro do servidor WebSocket:", serverMessage.error);
        } else {
            console.warn("[Listener] Mensagem do servidor não reconhecida:", serverMessage);
        }
      } catch (e) {
        console.error("[Listener] Erro ao processar mensagem do servidor (não JSON ou outro erro):", e, "Raw data:", event.data);
        setLastMessage("Erro ao processar dados do servidor.");
      }
    };

    newWs.onerror = (event) => {
       if (ws.current !== newWs && ws.current !== null) { console.log("[Listener] onerror: Conexão antiga ou nula, ignorando erro."); return; }
      console.error("[Listener] Erro no WebSocket:", event);
      setListenerState("error");
      setLastMessage("Erro na conexão WebSocket.");
      setIsSpeaking(false); setAudioActivated(false); 
      console.log("[Listener] onerror: Resetando lastSuccessfullyEnqueuedTextRef.current para null.");
      lastSuccessfullyEnqueuedTextRef.current = null;
    };

    newWs.onclose = (event) => {
      if (ws.current !== newWs && ws.current !== null) { console.log(`[Listener] onclose: Conexão antiga (URL: ${newWs.url}, Código: ${event.code}). Ignorando.`); return; }
      console.log(`[Listener] WebSocket desconectado (URL: ${newWs.url}). Código: ${event.code}, Limpo: ${event.wasClean}, Razão: ${event.reason}`);
      setListenerState("disconnected");
      if (event.code !== 1000) { // 1000 is normal closure
        setLastMessage("Desconectado. Tente recarregar a página.");
      } else {
        setLastMessage("Desconectado do servidor.");
      }
      setIsSpeaking(false); setAudioActivated(false);
      console.log("[Listener] onclose: Resetando lastSuccessfullyEnqueuedTextRef.current para null.");
      lastSuccessfullyEnqueuedTextRef.current = null;
      if(typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
      utteranceQueueRef.current = [];
      if (ws.current === newWs) ws.current = null; // Clear the ref if it's this specific instance
    };

    return () => {
      console.log(`[Listener] useEffect principal LIMPEZA. Resetando lastSuccessfullyEnqueuedTextRef.current. WebSocket URL: ${newWs.url}`);
      newWs.onopen = null; newWs.onmessage = null; newWs.onerror = null; newWs.onclose = null;
      if (newWs && (newWs.readyState === WebSocket.OPEN || newWs.readyState === WebSocket.CONNECTING) ) {
        newWs.close(1000, "Listener page unmounting or useEffect re-run");
      }
      if (ws.current === newWs) ws.current = null; 
      if(typeof window !== 'undefined' && window.speechSynthesis) window.speechSynthesis.cancel();
      utteranceQueueRef.current = []; 
      setIsSpeaking(false); // Reset speaking state
      lastSuccessfullyEnqueuedTextRef.current = null;
      console.log("[Listener] Cleanup do useEffect principal finalizado. lastSuccessfullyEnqueuedTextRef.current é:", lastSuccessfullyEnqueuedTextRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Empty dependency array to run once on mount and cleanup on unmount

  return (
    <div className="flex flex-col items-center min-h-screen p-4 md:p-8 bg-background text-foreground">
      <header className="w-full max-w-3xl mb-8">
        <div className="flex justify-center items-center mb-2">
          <LinguaVoxLogo className="h-12 w-auto" />
        </div>
        <p className="text-muted-foreground text-lg text-center">
          Página do Ouvinte - Reprodução da Tradução
        </p>
        <div className="text-center mt-2">
            <Link href="/" className="text-sm text-primary hover:underline flex items-center justify-center gap-1">
                <Mic size={16} />
                Ir para a Página de Transcrição
            </Link>
        </div>
      </header>

      <main className="w-full max-w-md">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <AudioLines className="text-primary" />
              Receptor de Tradução Falada
            </CardTitle>
            <CardDescription>
              Esta página reproduzirá automaticamente a tradução do áudio capturado na página de transcrição.
              {!audioActivated && listenerState === "connected" && " (Requer ativação de áudio abaixo)"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            {!audioActivated && listenerState === "connected" && (
              <div className="flex justify-center">
                <Button onClick={handleActivateAudio} className="px-6 py-3 text-base bg-primary hover:bg-primary/90 text-primary-foreground">
                  <PlayCircle size={18} className="mr-2" />
                  Ativar Áudio para Traduções
                </Button>
              </div>
            )}
            <div className="flex items-center justify-center p-6 bg-muted/50 rounded-md min-h-[100px]">
              {listenerState === "connecting" && (
                <div className="flex flex-col items-center text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin mb-2" />
                  Conectando ao servidor...
                </div>
              )}
              {listenerState === "connected" && !audioActivated && (
                 <p className="text-muted-foreground text-center">Clique em "Ativar Áudio" para ouvir as traduções.</p>
              )}
              {listenerState === "connected" && audioActivated && !isSpeaking && utteranceQueueRef.current.length === 0 && (
                <p className="text-muted-foreground">Aguardando tradução para falar...</p>
              )}
              {listenerState === "connected" && audioActivated && (isSpeaking || utteranceQueueRef.current.length > 0) && (
                 <p className="text-primary animate-pulse">
                    {isSpeaking ? "Falando tradução..." : `Tradução na fila (${utteranceQueueRef.current.length}). Preparando para falar...`}
                </p>
              )}
              {(listenerState === "disconnected" || listenerState === "error") && (
                 <div className="flex flex-col items-center text-destructive">
                  <WifiOff className="h-8 w-8 mb-2" />
                  {listenerState === "disconnected" ? "Desconectado." : "Erro de conexão."}
                   {listenerState === "error" && <span className="text-xs">{lastMessage}</span>}
                </div>
              )}
            </div>

            {lastMessage && (
              <p className="text-sm text-muted-foreground text-center mt-2">
                Última ação: {lastMessage}
              </p>
            )}
             {availableVoices.length === 0 && listenerState === "connected" && (
                <p className="text-xs text-muted-foreground text-center mt-2">
                    Carregando vozes de síntese...
                </p>
            )}
            {audioActivated && availableVoices.length > 0 && !isSpeaking && utteranceQueueRef.current.length === 0 && (
                 <p className="text-xs text-muted-foreground text-center mt-2">
                    Áudio ativado. {availableVoices.length} vozes de síntese disponíveis.
                </p>
            )}
          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox Listener. Todos os direitos reservados.</p>
      </footer>
    </div>
  );
}

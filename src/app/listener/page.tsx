
"use client";

import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Volume2, WifiOff, Loader2, Mic } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type ListenerState = "connecting" | "connected" | "disconnected" | "error";

export default function ListenerPage() {
  const ws = useRef<WebSocket | null>(null);
  const [listenerState, setListenerState] = useState<ListenerState>("connecting");
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const utteranceQueueRef = useRef<SpeechSynthesisUtterance[]>([]);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [availableVoices, setAvailableVoices] = useState<SpeechSynthesisVoice[]>([]);

  const getWebSocketUrl = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = process.env.NEXT_PUBLIC_WEBSOCKET_PORT || '3001';
    return `${protocol}//${window.location.hostname}:${wsPort}`;
  };

  useEffect(() => {
    // Load voices
    const loadVoices = () => {
      const voices = window.speechSynthesis.getVoices();
      if (voices.length > 0) {
        setAvailableVoices(voices);
        console.log("[Listener] Vozes de síntese carregadas:", voices.length);
      }
    };
    loadVoices();
    // Some browsers load voices asynchronously.
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }
  }, []);


  const speakNextInQueue = () => {
    if (isSpeaking || utteranceQueueRef.current.length === 0) {
      if (utteranceQueueRef.current.length === 0) setIsSpeaking(false);
      return;
    }

    setIsSpeaking(true);
    const utterance = utteranceQueueRef.current.shift();
    if (utterance) {
      console.log("[Listener] Tentando falar:", utterance.text.substring(0, 30) + "...", "Idioma:", utterance.lang);
      
      utterance.onstart = () => {
        console.log("[Listener] Síntese de fala iniciada.");
        setLastMessage(`Falando: "${utterance.text.substring(0,20)}..."`);
      };
      utterance.onend = () => {
        console.log("[Listener] Síntese de fala finalizada.");
        setIsSpeaking(false);
        speakNextInQueue(); // Try to speak next item in queue
      };
      utterance.onerror = (event) => {
        console.error("[Listener] Erro na síntese de fala:", event.error);
        setLastMessage(`Erro ao falar: ${event.error}`);
        setIsSpeaking(false);
        speakNextInQueue(); // Try next item even if current errors
      };
      window.speechSynthesis.speak(utterance);
    } else {
      setIsSpeaking(false);
    }
  };
  

  useEffect(() => {
    const WS_URL = getWebSocketUrl();
    console.log("[Listener] Tentando conectar ao WebSocket em:", WS_URL);
    setListenerState("connecting");

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      console.log("[Listener] WebSocket conectado.");
      setListenerState("connected");
      setLastMessage("Conectado ao servidor. Aguardando texto para falar...");
      if (ws.current) {
        ws.current.send(JSON.stringify({ action: "subscribe_audio" }));
        console.log("[Listener] Mensagem de inscrição enviada.");
      }
    };

    ws.current.onmessage = (event) => {
      try {
        const serverMessage = JSON.parse(event.data as string);
        console.log("[Listener] Mensagem recebida:", serverMessage.type);

        if (serverMessage.type === "translated_text_for_listener" && serverMessage.text && serverMessage.targetLanguage) {
          setLastMessage(`Texto traduzido recebido para ${serverMessage.targetLanguage} (${new Date().toLocaleTimeString()})`);
          
          const utterance = new SpeechSynthesisUtterance(serverMessage.text);
          
          // Try to set the voice based on targetLanguage
          const targetLangPrefix = serverMessage.targetLanguage.split('-')[0]; // e.g., "en" from "en-US"
          const voice = availableVoices.find(v => 
            v.lang.startsWith(serverMessage.targetLanguage) || v.lang.startsWith(targetLangPrefix)
          );

          if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
            console.log(`[Listener] Voz encontrada e definida para ${voice.name} (${voice.lang})`);
          } else {
            utterance.lang = serverMessage.targetLanguage; // Fallback to setting lang directly
            console.warn(`[Listener] Nenhuma voz específica encontrada para ${serverMessage.targetLanguage}. Usando padrão do navegador para o idioma, se disponível.`);
          }
          
          utteranceQueueRef.current.push(utterance);
          if (!isSpeaking) {
            speakNextInQueue();
          }
        } else if (serverMessage.message) {
          setLastMessage(serverMessage.message);
        } else if (serverMessage.error) {
           setLastMessage(`Erro do servidor: ${serverMessage.error}`);
           console.error("[Listener] Erro do servidor WebSocket:", serverMessage.error);
        }
      } catch (e) {
        console.error("[Listener] Erro ao processar mensagem do servidor:", e);
        setLastMessage("Erro ao processar dados do servidor.");
      }
    };

    ws.current.onerror = (event) => {
      console.error("[Listener] Erro no WebSocket:", event);
      setListenerState("error");
      setLastMessage("Erro na conexão WebSocket.");
      setIsSpeaking(false);
    };

    ws.current.onclose = (event) => {
      console.log(`[Listener] WebSocket desconectado. Código: ${event.code}, Limpo: ${event.wasClean}`);
      setListenerState("disconnected");
      setLastMessage("Desconectado do servidor.");
      setIsSpeaking(false);
      window.speechSynthesis.cancel(); // Stop any ongoing speech synthesis
      utteranceQueueRef.current = [];
    };

    return () => {
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        console.log("[Listener] Fechando WebSocket ao desmontar.");
        ws.current.close(1000, "Listener page unmounting");
      }
      ws.current = null;
      window.speechSynthesis.cancel(); // Ensure speech synthesis is stopped on unmount
      utteranceQueueRef.current = [];
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [availableVoices]); // Re-run if availableVoices changes

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
            <Link href="/" legacyBehavior>
              <a className="text-sm text-primary hover:underline flex items-center justify-center gap-1">
                <Mic size={16} />
                Ir para a Página de Transcrição
              </a>
            </Link>
        </div>
      </header>

      <main className="w-full max-w-md">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Volume2 className="text-primary" />
              Receptor de Tradução Falada
            </CardTitle>
            <CardDescription>
              Esta página reproduzirá automaticamente a tradução do áudio capturado na página de transcrição.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="flex items-center justify-center p-6 bg-muted/50 rounded-md min-h-[100px]">
              {listenerState === "connecting" && (
                <div className="flex flex-col items-center text-muted-foreground">
                  <Loader2 className="h-8 w-8 animate-spin mb-2" />
                  Conectando ao servidor...
                </div>
              )}
              {listenerState === "connected" && !isSpeaking && utteranceQueueRef.current.length === 0 && (
                <p className="text-muted-foreground">Aguardando tradução para falar...</p>
              )}
              {listenerState === "connected" && (isSpeaking || utteranceQueueRef.current.length > 0) && (
                 <p className="text-primary animate-pulse">
                    {isSpeaking ? "Falando tradução..." : "Tradução na fila para falar..."}
                </p>
              )}
              {(listenerState === "disconnected" || listenerState === "error") && (
                 <div className="flex flex-col items-center text-destructive">
                  <WifiOff className="h-8 w-8 mb-2" />
                  {listenerState === "disconnected" ? "Desconectado." : "Erro de conexão."}
                </div>
              )}
            </div>
            
            {lastMessage && (
              <p className="text-sm text-muted-foreground text-center mt-2">
                Status: {lastMessage}
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
    
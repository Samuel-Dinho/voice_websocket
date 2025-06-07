
"use client";

import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Volume2, WifiOff, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

type ListenerState = "connecting" | "connected" | "disconnected" | "error";

export default function ListenerPage() {
  const ws = useRef<WebSocket | null>(null);
  const audioPlayerRef = useRef<HTMLAudioElement | null>(null);
  const [audioSrc, setAudioSrc] = useState<string | null>(null);
  const [listenerState, setListenerState] = useState<ListenerState>("connecting");
  const [lastMessage, setLastMessage] = useState<string | null>(null);
  const audioQueueRef = useRef<string[]>([]);
  const [isPlaying, setIsPlaying] = useState(false);


  const getWebSocketUrl = () => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsPort = process.env.NEXT_PUBLIC_WEBSOCKET_PORT || '3001';
    return `${protocol}//${window.location.hostname}:${wsPort}`;
  };

  const playNextInQueue = () => {
    if (audioQueueRef.current.length > 0 && audioPlayerRef.current) {
      const nextAudioSrc = audioQueueRef.current.shift(); // Get and remove the first item
      if (nextAudioSrc) {
        setAudioSrc(nextAudioSrc); // This will trigger the useEffect to play
      }
    } else {
      setIsPlaying(false); // No more audio in queue
    }
  };
  
  useEffect(() => {
    if (audioSrc && audioPlayerRef.current) {
      audioPlayerRef.current.src = audioSrc;
      audioPlayerRef.current.load(); // Important to load new src
      audioPlayerRef.current.play()
        .then(() => {
            setIsPlaying(true);
            console.log("[Listener] Reproduzindo áudio:", audioSrc.substring(0, 50) + "...");
        })
        .catch(error => {
          console.error("[Listener] Erro ao tentar reproduzir áudio:", error);
          setIsPlaying(false);
          // Browsers often block autoplay without user interaction.
          // Could add a button "Click to enable audio"
          setLastMessage("Erro ao reproduzir áudio. Pode ser necessário interação do usuário.");
          playNextInQueue(); // Try next if current fails
        });
    }
  }, [audioSrc]);


  useEffect(() => {
    const WS_URL = getWebSocketUrl();
    console.log("[Listener] Tentando conectar ao WebSocket em:", WS_URL);
    setListenerState("connecting");

    ws.current = new WebSocket(WS_URL);

    ws.current.onopen = () => {
      console.log("[Listener] WebSocket conectado.");
      setListenerState("connected");
      setLastMessage("Conectado ao servidor. Aguardando áudio...");
      if (ws.current) {
        ws.current.send(JSON.stringify({ action: "subscribe_audio" }));
        console.log("[Listener] Mensagem de inscrição enviada.");
      }
    };

    ws.current.onmessage = (event) => {
      try {
        const serverMessage = JSON.parse(event.data as string);
        console.log("[Listener] Mensagem recebida:", serverMessage.type);

        if (serverMessage.type === "audio_chunk" && serverMessage.audioDataUri) {
          setLastMessage(`Chunk de áudio recebido (${new Date().toLocaleTimeString()})`);
          audioQueueRef.current.push(serverMessage.audioDataUri);
          if (!isPlaying && audioPlayerRef.current && audioPlayerRef.current.paused) {
            playNextInQueue();
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
    };

    ws.current.onclose = (event) => {
      console.log(`[Listener] WebSocket desconectado. Código: ${event.code}, Limpo: ${event.wasClean}`);
      setListenerState("disconnected");
      setLastMessage("Desconectado do servidor.");
      setIsPlaying(false);
    };

    return () => {
      if (ws.current && ws.current.readyState === WebSocket.OPEN) {
        console.log("[Listener] Fechando WebSocket ao desmontar.");
        ws.current.close(1000, "Listener page unmounting");
      }
      ws.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Connect only once on mount

  return (
    <div className="flex flex-col items-center min-h-screen p-4 md:p-8 bg-background text-foreground">
      <header className="w-full max-w-3xl mb-8">
        <div className="flex justify-center items-center mb-2">
          <LinguaVoxLogo className="h-12 w-auto" />
        </div>
        <p className="text-muted-foreground text-lg text-center">
          Página do Ouvinte - Áudio em Tempo Real
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
              Receptor de Áudio
            </CardTitle>
            <CardDescription>
              Esta página reproduzirá o áudio capturado pela página de transcrição em tempo real.
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
              {listenerState === "connected" && !isPlaying && audioQueueRef.current.length === 0 && (
                <p className="text-muted-foreground">Aguardando áudio para reproduzir...</p>
              )}
              {listenerState === "connected" && (isPlaying || audioQueueRef.current.length > 0) && (
                 <p className="text-primary animate-pulse">
                    {isPlaying ? "Reproduzindo áudio..." : "Áudio na fila..."}
                </p>
              )}
              {(listenerState === "disconnected" || listenerState === "error") && (
                 <div className="flex flex-col items-center text-destructive">
                  <WifiOff className="h-8 w-8 mb-2" />
                  {listenerState === "disconnected" ? "Desconectado." : "Erro de conexão."}
                </div>
              )}
            </div>
            <audio 
                ref={audioPlayerRef} 
                controls 
                className="w-full"
                onEnded={() => {
                    console.log("[Listener] Reprodução de áudio finalizada.");
                    setIsPlaying(false);
                    playNextInQueue();
                }}
                onError={(e) => {
                    console.error("[Listener] Erro no elemento de áudio:", e);
                    setIsPlaying(false);
                    setLastMessage("Erro ao carregar/reproduzir áudio.");
                    playNextInQueue(); // Try next if current fails
                }}
            >
              Seu navegador não suporta o elemento de áudio.
            </audio>
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

    
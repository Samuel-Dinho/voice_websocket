
"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Mic, MicOff, Loader2, AlertTriangle, Edit3 } from "lucide-react";
import { LanguageSelector } from "@/components/LanguageSelector";
import { supportedLanguages } from "@/lib/languages";
import { useToast } from "@/hooks/use-toast";
import { LinguaVoxLogo } from "@/components/icons/LinguaVoxLogo";
import { Separator } from "@/components/ui/separator";

type StreamingState = "idle" | "recognizing" | "error" | "stopping";

let recognition: SpeechRecognition | null = null;

export default function LinguaVoxPage() {
  const [sourceLanguage, setSourceLanguage] = useState<string>("pt-BR");
  const [streamingState, setStreamingState] = useState<StreamingState>("idle");
  const [transcribedText, setTranscribedText] = useState<string>("");
  const [interimTranscribedText, setInterimTranscribedText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const { toast } = useToast();

  const isSpeechRecognitionSupported = useCallback(() => {
    const supported = typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
    console.log("[Client] SpeechRecognition supported:", supported);
    return supported;
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

  const startRecognition = useCallback(() => {
    console.log("[Client] Attempting to start recognition. Current state:", streamingState, "Source language:", sourceLanguage);
    if (!isSpeechRecognitionSupported()) {
      setError("Reconhecimento de fala não suportado.");
      setStreamingState("error");
      toast({ title: "Erro Crítico", description: "API de Reconhecimento de Fala não disponível (verificação em startRecognition).", variant: "destructive" });
      console.error("[Client] SpeechRecognition not supported (checked in startRecognition).");
      return;
    }

    if (streamingState === "recognizing") {
      console.warn("[Client] Attempting to start recognition when already in progress.");
      return;
    }

    setStreamingState("recognizing");
    setError(null);
    setTranscribedText(""); // Limpa transcrição anterior ao iniciar uma nova
    setInterimTranscribedText("");
    toast({ title: "Microfone Ativado", description: "Iniciando reconhecimento de fala..." });

    const SpeechRecognitionAPI = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionAPI) {
        setError("API de Reconhecimento de Fala não encontrada no navegador.");
        setStreamingState("error");
        toast({ title: "Erro Crítico", description: "API de Reconhecimento de Fala não encontrada no objeto window.", variant: "destructive" });
        console.error("[Client] SpeechRecognitionAPI not found in window object.");
        return;
    }
    
    try {
      recognition = new SpeechRecognitionAPI();
    } catch (e: any) {
      console.error("[Client] Error creating SpeechRecognition instance:", e);
      setError(`Erro ao criar instância de SpeechRecognition: ${e.message}`);
      setStreamingState("error");
      toast({ title: "Erro de Inicialização", description: `Não foi possível criar SpeechRecognition: ${e.message}`, variant: "destructive" });
      return;
    }
    
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = sourceLanguage;

    console.log(`[Client] SpeechRecognition instance created. Language: ${sourceLanguage}`);

    recognition.onstart = () => {
      console.log("[Client] SpeechRecognition started successfully.");
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
      
      if (final_transcript) {
         setTranscribedText(prev => (prev ? prev.trim() + " " : "") + final_transcript.trim());
      }
      setInterimTranscribedText(interim_transcript.trim());
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      console.error("[Client] SpeechRecognition Error Event:", event);
      let errMessage = `Erro no reconhecimento: ${event.error}`;
      if (event.error === 'network') {
        errMessage = "Erro de rede durante o reconhecimento. Verifique sua conexão.";
      } else if (event.error === 'no-speech') {
        errMessage = "Nenhuma fala detectada. Tente falar mais alto ou verifique o microfone.";
      } else if (event.error === 'audio-capture') {
        errMessage = "Falha na captura de áudio. Verifique as permissões do microfone.";
      } else if (event.error === 'not-allowed') {
        errMessage = "Permissão para usar o microfone negada ou não solicitada. Verifique as configurações de permissão do site no navegador.";
      } else if (event.error === 'language-not-supported') {
        errMessage = `O idioma '${sourceLanguage}' não é suportado pelo reconhecimento de fala do seu navegador.`;
      } else if (event.message) {
        errMessage += `. Detalhes: ${event.message}`;
      }
      setError(errMessage);
      setStreamingState("error");
      toast({ title: "Erro de Reconhecimento", description: errMessage, variant: "destructive" });
      if (recognition && (streamingState === "recognizing" || streamingState === "stopping") ) { // Ensure it stops only if it was trying to run
        recognition.stop();
      }
    };

    recognition.onend = () => {
      console.log("[Client] SpeechRecognition ended. Current state:", streamingState);
      if (streamingState === "recognizing" || streamingState === "stopping") {
        setStreamingState("idle");
        setInterimTranscribedText(""); 
      }
    };
    
    console.log("[Client] Calling recognition.start()...");
    try {
      recognition.start();
    } catch (e: any) {
      console.error("[Client] Error calling recognition.start():", e);
      setError(`Erro ao iniciar reconhecimento: ${e.message}`);
      setStreamingState("error");
      toast({ title: "Erro ao Iniciar", description: `Não foi possível iniciar o reconhecimento: ${e.message}`, variant: "destructive" });
      if (recognition && (streamingState === "recognizing" || streamingState === "stopping")) {
        recognition.stop();
      }
    }

  }, [sourceLanguage, toast, streamingState, isSpeechRecognitionSupported]);

  const stopRecognition = useCallback(() => {
    console.log("[Client] Attempting to stop recognition...");
    setStreamingState("stopping");
    if (recognition) {
      try {
        recognition.stop();
        console.log("[Client] recognition.stop() called.");
      } catch (e: any) {
        console.error("[Client] Error calling recognition.stop():", e);
        // Mesmo se stop() falhar, tentamos garantir o estado idle.
        setStreamingState("idle"); 
      }
    } else {
       // Se recognition for null, mas estávamos tentando parar, apenas mudamos o estado.
       setStreamingState("idle");
    }
  }, []);

  const handleToggleStreaming = () => {
    console.log("[Client] handleToggleStreaming called. Current state:", streamingState);
    if (streamingState === "recognizing") {
      stopRecognition();
    } else if (streamingState === "idle" || streamingState === "error") {
      startRecognition();
    }
  };
  
  useEffect(() => {
    return () => {
      if (recognition) {
        console.log("[Client] Component unmounting, aborting SpeechRecognition if active.");
        recognition.abort(); 
        recognition = null;
      }
    };
  }, []);


  const StreamButtonIcon = streamingState === "recognizing" ? MicOff : Mic;
  let streamButtonText = "Iniciar Transcrição";
  if (streamingState === "recognizing") streamButtonText = "Parar Transcrição";
  if (streamingState === "stopping") streamButtonText = "Parando...";
  
  const isButtonDisabled = streamingState === "stopping"; // Simplificado: só desabilita se estiver parando.
                                                       // Se houver erro, o usuário pode tentar novamente.
                                                       // A checagem de suporte já é feita em startRecognition.
  const isLoading = streamingState === "stopping";

  return (
    <div className="flex flex-col items-center min-h-screen p-4 md:p-8 bg-background text-foreground">
      <header className="w-full max-w-3xl mb-8 text-center">
        <div className="flex justify-center items-center mb-2">
          <LinguaVoxLogo className="h-12 w-auto" />
        </div>
        <p className="text-muted-foreground text-lg">
          Transcrição de Áudio em Tempo Real (no Navegador)
        </p>
      </header>

      <main className="w-full max-w-3xl">
        <Card className="shadow-xl">
          <CardHeader>
            <CardTitle className="text-2xl flex items-center gap-2">
              <Edit3 className="text-primary" />
              Transcritor de Fala (Local)
            </CardTitle>
            <CardDescription>
              Selecione o idioma de origem e inicie para transcrição em tempo real usando a API Web Speech do seu navegador.
               <br/>
              <span className="text-xs text-muted-foreground">Nota: A qualidade e suporte a idiomas dependem do seu navegador. Verifique as permissões do microfone.</span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-1 gap-6">
              <LanguageSelector
                id="source-language"
                label="Idioma de Origem da Fala"
                value={sourceLanguage}
                onValueChange={(value) => {
                  if (streamingState !== "recognizing" && streamingState !== "stopping") {
                    setSourceLanguage(value);
                    console.log("[Client] Source language changed to:", value);
                  } else {
                    console.log("[Client] Cannot change language while recognizing or stopping.");
                  }
                }}
                languages={supportedLanguages.map(lang => ({
                    ...lang,
                    code: lang.code === "en" ? "en-US" : 
                          lang.code === "es" ? "es-ES" :
                          lang.code === "fr" ? "fr-FR" :
                          lang.code === "de" ? "de-DE" :
                          lang.code === "it" ? "it-IT" :
                          lang.code === "pt" ? "pt-BR" :
                          lang.code 
                }))}
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
              {(streamingState === "recognizing") && (
                 <p className="text-sm text-primary animate-pulse">Reconhecendo fala...</p>
              )}
            </div>

            {error && (
              <div className="mt-4 p-4 bg-destructive/10 border border-destructive/30 rounded-md text-destructive flex items-center gap-2">
                <AlertTriangle className="h-5 w-5"/> 
                <p>{error}</p>
              </div>
            )}
            
            {(transcribedText || interimTranscribedText) && (
              <div className="mt-6 space-y-3">
                <div className="flex justify-between items-center">
                  <h3 className="text-xl font-semibold font-headline">Transcrição:</h3>
                </div>
                <Textarea
                  value={transcribedText + (interimTranscribedText ? (transcribedText ? " " : "") + interimTranscribedText : "")}
                  readOnly
                  rows={8}
                  className="bg-muted/50 border-border text-lg p-4 rounded-md shadow-inner"
                  aria-label="Texto transcrito"
                />
              </div>
            )}
          </CardContent>
        </Card>
      </main>
      <footer className="w-full max-w-3xl mt-12 text-center text-sm text-muted-foreground">
        <p>&copy; {new Date().getFullYear()} LinguaVox. Todos os direitos reservados.</p>
        <p className="mt-1">Transcrição de áudio local usando a API Web Speech do navegador.</p>
      </footer>
    </div>
  );
}

    
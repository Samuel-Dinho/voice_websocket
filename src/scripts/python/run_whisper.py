# src/scripts/python/run_whisper.py

import sys
import os
import whisper

# Documentação do Script:
# Este script é uma ferramenta de linha de comando para transcrever áudio usando Whisper.
#
# Como Usar no Terminal:
# python3 run_whisper.py <caminho_do_audio> [modelo] [idioma]
#
# Exemplo:
# python3 run_whisper.py /tmp/audio123.webm base pt
#
# Argumentos:
# 1. <caminho_do_audio> (obrigatório): Caminho para o arquivo de áudio.
# 2. [modelo] (opcional, padrão: "base"): "tiny", "base", "small", "medium", "large".
# 3. [idioma] (opcional, padrão: "auto"): Código do idioma ('pt', 'en') ou 'auto' para detecção.
#
# Saída:
# - Se sucesso -> O texto transcrito é impresso na saída padrão (stdout).
# - Se erro -> A mensagem de erro é impressa na saída de erro (stderr).

if __name__ == "__main__":
    # Força a saída padrão para UTF-8 para lidar com caracteres especiais
    if sys.stdout.encoding != 'utf-8':
        try:
            sys.stdout.reconfigure(encoding='utf-8')
            sys.stderr.reconfigure(encoding='utf-8')
        except Exception as e:
            print(f"Warning: Could not reconfigure stdout/stderr to UTF-8: {e}", file=sys.stderr)


    # Validação dos argumentos
    if len(sys.argv) < 2:
        print("Erro: Forneça pelo menos o caminho do arquivo de áudio.", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"
    language = sys.argv[3] if len(sys.argv) > 3 else "auto"

    try:
        if not os.path.exists(audio_file):
            print(f"Erro: Arquivo de áudio não encontrado em '{os.path.abspath(audio_file)}'", file=sys.stderr)
            sys.exit(1)
        
        # Carrega o modelo (pode baixar na primeira vez)
        # Modelos podem ser: "tiny", "base", "small", "medium", "large", "large-v2", "large-v3"
        # Modelos menores são mais rápidos mas menos precisos.
        model = whisper.load_model(model_size)

        options = {}
        if language and language.lower() != "auto":
            options["language"] = language

        # A mágica acontece aqui!
        result = model.transcribe(audio_file, **options)

        # Imprime o resultado final para ser capturado pelo Node.js
        print(result["text"])

    except Exception as e:
        print(f"Ocorreu um erro no Whisper: {e}", file=sys.stderr)
        sys.exit(1)

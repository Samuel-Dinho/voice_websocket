
# src/scripts/python/run_whisper.py

import sys
import os
import whisper
import subprocess # For calling ffmpeg
import tempfile   # For creating temporary WAV file

# Documentação do Script:
# Este script é uma ferramenta de linha de comando para transcrever áudio usando Whisper.
# Ele agora tenta converter o arquivo de entrada para WAV usando FFmpeg antes da transcrição.
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

    original_audio_file = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"
    language = sys.argv[3] if len(sys.argv) > 3 else "auto"

    temp_wav_file_path = None

    try:
        if not os.path.exists(original_audio_file):
            print(f"Erro: Arquivo de áudio original não encontrado em '{original_audio_file}'", file=sys.stderr)
            sys.exit(1)
        
        # 1. Tentar converter o áudio de entrada para WAV usando FFmpeg
        #    Isso ajuda o Whisper a lidar com formatos que ele pode não suportar diretamente
        #    ou que são problemáticos (como chunks WebM).
        
        # Criar um nome de arquivo WAV temporário
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as temp_wav_file:
            temp_wav_file_path = temp_wav_file.name
        
        ffmpeg_command = [
            "ffmpeg",
            "-y",  # Sobrescrever arquivo de saída se existir
            "-i", original_audio_file,
            "-acodec", "pcm_s16le", # Formato WAV padrão (16-bit PCM)
            "-ar", "16000",         # Taxa de amostragem de 16kHz (comum para STT)
            "-ac", "1",             # Mono
            temp_wav_file_path
        ]
        
        print(f"Info: Tentando converter '{original_audio_file}' para WAV em '{temp_wav_file_path}' com comando: {' '.join(ffmpeg_command)}", file=sys.stderr)
        
        process = subprocess.Popen(ffmpeg_command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        ffmpeg_stdout, ffmpeg_stderr = process.communicate()

        if process.returncode != 0:
            print(f"Erro: FFmpeg falhou ao converter o arquivo para WAV.", file=sys.stderr)
            print(f"FFmpeg stdout: {ffmpeg_stdout.decode('utf-8', errors='ignore')}", file=sys.stderr)
            print(f"FFmpeg stderr: {ffmpeg_stderr.decode('utf-8', errors='ignore')}", file=sys.stderr)
            # Continuar tentando com o arquivo original se a conversão falhar, 
            # mas o Whisper pode falhar também.
            audio_to_transcribe = original_audio_file
            print(f"Info: Conversão FFmpeg falhou. Tentando transcrever o arquivo original: {original_audio_file}", file=sys.stderr)
        else:
            print(f"Info: FFmpeg converteu com sucesso para '{temp_wav_file_path}'.", file=sys.stderr)
            audio_to_transcribe = temp_wav_file_path

        # 2. Carregar o modelo Whisper
        # Modelos podem ser: "tiny", "base", "small", "medium", "large", "large-v2", "large-v3"
        model = whisper.load_model(model_size)

        options = {}
        if language and language.lower() != "auto":
            options["language"] = language

        # 3. Transcrever o áudio (WAV convertido ou original se a conversão falhou)
        print(f"Info: Transcrevendo arquivo: '{audio_to_transcribe}' com modelo '{model_size}' e idioma '{language}'", file=sys.stderr)
        result = model.transcribe(audio_to_transcribe, **options)

        # 4. Imprimir o resultado final para ser capturado pelo Node.js
        print(result["text"])

    except Exception as e:
        print(f"Ocorreu um erro no script Python (run_whisper.py): {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        # 5. Limpar o arquivo WAV temporário se foi criado
        if temp_wav_file_path and os.path.exists(temp_wav_file_path):
            try:
                os.unlink(temp_wav_file_path)
                print(f"Info: Arquivo WAV temporário removido: {temp_wav_file_path}", file=sys.stderr)
            except Exception as e:
                print(f"Warning: Falha ao remover arquivo WAV temporário {temp_wav_file_path}: {e}", file=sys.stderr)


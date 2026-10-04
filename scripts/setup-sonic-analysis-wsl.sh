#!/usr/bin/env bash
set -euo pipefail
# Isolated from the existing EffNet runtime. Requires the user's micromamba.
root="$(cd "$(dirname "$0")/.." && pwd)"
manager="${SONIC_MICROMAMBA:-$HOME/.local/bin/micromamba}"
env_root="${SONIC_ANALYSIS_ENV_ROOT:-$HOME/micromamba-root/envs/rabbit-hole-mert2}"
if [[ ! -x "$env_root/bin/python" ]]; then
  "$manager" create -y -p "$env_root" -c conda-forge python=3.11 ffmpeg=6.1 pip
fi
"$env_root/bin/python" -m pip install torch==2.8.0 torchaudio==2.8.0 --index-url https://download.pytorch.org/whl/cu128
"$env_root/bin/python" -m pip install transformers==4.53.2 huggingface-hub==0.36.0 safetensors==0.5.3 numpy==1.26.4 scipy==1.13.1 soundfile==0.13.1 onnxruntime==1.22.1 nnAudio==0.3.4
"$env_root/bin/python" -m venv --system-site-packages "$env_root/mert1"
"$env_root/mert1/bin/python" -m pip install transformers==4.38.2
"$env_root/bin/python" -m venv --system-site-packages "$env_root/sheetsage"
"$env_root/sheetsage/bin/python" -m pip install transformers==4.45.2 mir_eval==0.8.2 pretty_midi==0.2.10 mido==1.3.3 setuptools==78.1.1
"$env_root/bin/python" "$root/scripts/sonic-download-models.py"

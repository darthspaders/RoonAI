#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
base="${SONIC_ANALYSIS_ENV_ROOT:-$HOME/micromamba-root/envs/rabbit-hole-mert2}"
case "${1:-mert2}" in
  mert2) python_bin="$base/bin/python" ;;
  mert1) python_bin="$base/mert1/bin/python" ;;
  sheetsage) python_bin="$base/sheetsage/bin/python" ;;
  effnet) effnet_root="${RABBIT_HOLE_SONIC_ESSENTIA_VENV:-$HOME/micromamba-root/envs/rabbit-hole-effnet-gpu}"
    python_bin="$effnet_root/bin/python"
    export CUDA_VISIBLE_DEVICES=-1 TF_CPP_MIN_LOG_LEVEL=2
    export TF_NUM_INTRAOP_THREADS=2 TF_NUM_INTEROP_THREADS=1
    export LD_LIBRARY_PATH="$effnet_root/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}" ;;
  *) exit 2 ;;
esac
export PATH="$base/bin:$PATH"
export OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 TOKENIZERS_PARALLELISM=false
export HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 HF_HUB_DISABLE_TELEMETRY=1
exec "$python_bin" -u "$root/scripts/sonic-analysis-worker.py" --device "${2:-cuda}"

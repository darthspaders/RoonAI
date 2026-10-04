#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
venv_dir="${RABBIT_HOLE_SONIC_ESSENTIA_VENV:-${HOME}/rabbit-hole-sonic-venv}"
model_path="${RABBIT_HOLE_SONIC_ESSENTIA_MODEL_PATH:-${HOME}/rabbit-hole-sonic-models/discogs_track_embeddings-effnet-bs64-1.pb}"
worker_path="${RABBIT_HOLE_SONIC_ESSENTIA_BATCH_WORKER:-${script_dir}/sonic-essentia-batch-embed.py}"

export TF_CPP_MIN_LOG_LEVEL="${TF_CPP_MIN_LOG_LEVEL:-2}"
export TF_FORCE_GPU_ALLOW_GROWTH="${TF_FORCE_GPU_ALLOW_GROWTH:-true}"
source "${script_dir}/sonic-essentia-cuda-env.sh" "${venv_dir}"
if [[ "${RABBIT_HOLE_SONIC_ESSENTIA_DEVICE:-cpu}" != "cuda" ]]; then
  export CUDA_VISIBLE_DEVICES=""
else
  export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
fi

exec "${venv_dir}/bin/python" "${worker_path}" \
  --manifest "${1:?manifest path is required}" \
  --model "${model_path}" \
  --model-name "${RABBIT_HOLE_SONIC_ESSENTIA_MODEL_NAME:-discogs_track_embeddings-effnet-bs64-1}" \
  --output "${RABBIT_HOLE_SONIC_ESSENTIA_OUTPUT:-PartitionedCall:1}" \
  --expected-dimensions "${RABBIT_HOLE_SONIC_ESSENTIA_DIMENSIONS:-1280}" \
  --sample-rate "${RABBIT_HOLE_SONIC_ESSENTIA_SAMPLE_RATE:-16000}"

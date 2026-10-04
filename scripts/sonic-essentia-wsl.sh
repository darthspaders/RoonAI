#!/usr/bin/env bash
set -euo pipefail

# WSL launcher for the source-independent PCM worker. The Node process sends
# mono float32 PCM on stdin; this wrapper keeps Python/Essentia outside the
# Windows/Roon runtime and resolves the model from the WSL user's home.
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
venv_dir="${RABBIT_HOLE_SONIC_ESSENTIA_VENV:-${HOME}/rabbit-hole-sonic-venv}"
model_path="${RABBIT_HOLE_SONIC_ESSENTIA_MODEL_PATH:-${HOME}/rabbit-hole-sonic-models/discogs_track_embeddings-effnet-bs64-1.pb}"

# The installed Essentia TensorFlow wheel expects CUDA 11 runtime libraries,
# while this host exposes a newer CUDA driver. Keep CPU as the safe default;
# the verified GPU environment can opt in with RABBIT_HOLE_SONIC_ESSENTIA_DEVICE=cuda.
export TF_CPP_MIN_LOG_LEVEL="${TF_CPP_MIN_LOG_LEVEL:-2}"
export TF_FORCE_GPU_ALLOW_GROWTH="${TF_FORCE_GPU_ALLOW_GROWTH:-true}"
source "${script_dir}/sonic-essentia-cuda-env.sh" "${venv_dir}"
if [[ "${RABBIT_HOLE_SONIC_ESSENTIA_DEVICE:-cpu}" != "cuda" ]]; then
  export CUDA_VISIBLE_DEVICES=""
else
  export CUDA_VISIBLE_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
fi

exec "${venv_dir}/bin/python" "${script_dir}/sonic-essentia-embed.py" \
  --pcm-stdin \
  --model "${model_path}" \
  --model-name "discogs_track_embeddings-effnet-bs64-1" \
  --output "PartitionedCall:1" \
  --expected-dimensions 1280 \
  --sample-rate 16000 \
  --batch-size 64 \
  --patch-size 128 \
  --patch-hop-size 62

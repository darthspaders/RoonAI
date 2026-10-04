#!/usr/bin/env bash
set -euo pipefail

# Essentia's TensorFlow wheel is kept inside the dedicated sonic-analysis
# virtual environment.  NVIDIA's pip CUDA wheels place their shared objects
# below site-packages/nvidia/*/lib rather than in the venv root, so expose all
# of those directories before importing Essentia.
venv_dir="${1:?Essentia virtual environment path is required}"
site_packages="$(${venv_dir}/bin/python -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
nvidia_lib_path=""
if [[ -d "${site_packages}/nvidia" ]]; then
  while IFS= read -r lib_dir; do
    nvidia_lib_path="${nvidia_lib_path}${nvidia_lib_path:+:}${lib_dir}"
  done < <(find "${site_packages}/nvidia" -maxdepth 2 -type d -name lib -print)
fi

base_lib_path="${venv_dir}/lib:/usr/lib/wsl/lib"
if [[ -n "${nvidia_lib_path}" ]]; then
  export LD_LIBRARY_PATH="${nvidia_lib_path}:${base_lib_path}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
else
  export LD_LIBRARY_PATH="${base_lib_path}${LD_LIBRARY_PATH:+:${LD_LIBRARY_PATH}}"
fi

# CUDA_VISIBLE_DEVICES only expresses intent; it does not prove that the
# TensorFlow runtime can register a GPU.  Preflight the same Essentia graph so
# callers never record a false cuda:0 result after a silent CPU fallback.
if [[ "${RABBIT_HOLE_SONIC_ESSENTIA_DEVICE:-cpu}" == "cuda" ]]; then
  model_path="${RABBIT_HOLE_SONIC_ESSENTIA_MODEL_PATH:-${HOME}/rabbit-hole-sonic-models/discogs_track_embeddings-effnet-bs64-1.pb}"
  probe_log="$(mktemp)"
  trap 'rm -f "${probe_log}"' EXIT
  if ! TF_CPP_MIN_LOG_LEVEL=0 "${venv_dir}/bin/python" -c 'import sys; from essentia.standard import TensorflowPredictEffnetDiscogs; TensorflowPredictEffnetDiscogs(graphFilename=sys.argv[1], output="PartitionedCall:1", batchSize=64, patchSize=128, patchHopSize=62, lastBatchMode="same", lastPatchMode="discard")' "${model_path}" > /dev/null 2>"${probe_log}"; then
    echo "Essentia CUDA preflight failed; refusing to label this run as GPU-backed." >&2
    tail -40 "${probe_log}" >&2 || true
    exit 78
  fi
  if ! grep -Eq "Created TensorFlow device .*GPU:0" "${probe_log}"; then
    echo "Essentia CUDA preflight did not register TensorFlow GPU:0; refusing CPU fallback under CUDA mode." >&2
    tail -40 "${probe_log}" >&2 || true
    exit 78
  fi
  export RABBIT_HOLE_SONIC_ESSENTIA_RUNTIME_DEVICE="cuda:0"
else
  export RABBIT_HOLE_SONIC_ESSENTIA_RUNTIME_DEVICE="cpu"
fi

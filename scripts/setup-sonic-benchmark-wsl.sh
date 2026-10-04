#!/usr/bin/env bash
set -euo pipefail

# One-time, isolated WSL2 setup for the Recommendation Engine v2 neural
# benchmark. This never installs Python packages into the Node application.
# The apt commands intentionally remain visible so sudo authentication happens
# in the user's WSL session.

repo_dir="${1:-$(pwd)}"
venv_dir="/home/${USER}/rabbit-hole-sonic-venv"
model_dir="/home/${USER}/rabbit-hole-sonic-models"

sudo apt-get update
sudo apt-get install -y python3-pip python3.12-venv ffmpeg curl

python3 -m venv "${venv_dir}"
"${venv_dir}/bin/python" -m pip install --upgrade pip
"${venv_dir}/bin/python" -m pip install \
  numpy==2.2.6 \
  soundfile \
  essentia-tensorflow \
  scipy==1.13.1 \
  nnAudio
"${venv_dir}/bin/python" -m pip install \
  torch==2.6.0+cpu \
  --index-url https://download.pytorch.org/whl/cpu
"${venv_dir}/bin/python" -m pip install transformers==4.38.2

mkdir -p "${model_dir}"
multi_model="${model_dir}/discogs_multi_embeddings-effnet-bs64-1.pb"
if [[ ! -f "${multi_model}" ]]; then
  curl --fail --location --retry 3 \
    "https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs_multi_embeddings-effnet-bs64-1.pb" \
    --output "${multi_model}"
fi

track_model="${model_dir}/discogs_track_embeddings-effnet-bs64-1.pb"
if [[ ! -f "${track_model}" ]]; then
  curl --fail --location --retry 3 \
    "https://essentia.upf.edu/models/feature-extractors/discogs-effnet/discogs_track_embeddings-effnet-bs64-1.pb" \
    --output "${track_model}"
fi

"${venv_dir}/bin/python" -c "import essentia, numpy, torch, transformers; print('sonic benchmark environment ready')"
echo "Venv: ${venv_dir}"
echo "Discogs-EffNet multi-target model: ${multi_model}"
echo "Discogs-EffNet track-similarity model: ${track_model}"
echo "Run the benchmark from: ${repo_dir}"

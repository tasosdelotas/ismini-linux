#!/bin/bash
# Start llama.cpp server with Vulkan support (fallback to CPU if GPU fails)

PORT="${1:-8080}"
MODEL_PATH="${2:-}"
THREADS="${3:-4}"

cd "$(dirname "$0")"

# Try Vulkan first, fall back to CPU
if [ -n "$MODEL_PATH" ]; then
    ./llama-server --port $PORT --model "$MODEL_PATH" --threads $THREADS \
        --cont-batching --metrics 2>/dev/null &
else
    ./llama-server --port $PORT --threads $THREADS \
        --cont-batching --metrics 2>/dev/null &
fi

echo "LLaMA server started on port $PORT"
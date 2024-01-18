#!/bin/bash

CMD="node src/contract-100L.js"

until $CMD &>> run.log; do
    echo $(date +%Y-%m-%d_%H-%M-%S)
    echo "Crashed with exit code $?.  Respawning.." >&2
    sleep 30
done

# free-music-demixer

A free client-side static website for music demixing (aka music source separation) using the AI model Open-Unmix (with UMX-L weights):
<br>
<img src="docs/assets/images/music-demix.png" width="50%"/>

I transliterated the original PyTorch model Python code to C++ using Eigen. It compiles to WebAssembly with Emscripten. The UMX-L weights are quantized (mostly uint8, uint16 for the last 4 layers) and saved with the ggml binary file format. They are then gzipped. This reduces the 425 MB of UMX-L weights down to 45 MB, while achieving similar performance (verified empirically using BSS metrics).

This is based on [umx.cpp](https://github.com/sevagh/umx.cpp), my other project. This repo focuses on the WASM and web aspects, while umx.cpp is more about maintaining 1:1 performance parity with the original Open-Unmix (supporting both umxhq and umxl). 

### Streaming UMX architecture

Aside from the quantization, I recently implemented a streaming version of UMX inference to reduce the memory usage and allow for longer songs to be demixed on <https://freemusicdemixer.com>. The results are that the longest MUSDB18-HQ test song, 'Georgia Wonder - Siren', is now demixable by the WASM code in the web app:
```
umx.cpp results (non-streaming, default UMXL inference with quantized weights):
    vocals          ==> SDR:   5.553  SIR:  10.395  ISR:  13.159  SAR:   5.862
    drums           ==> SDR:   6.767  SIR:  12.154  ISR:  12.629  SAR:   7.438
    bass            ==> SDR:   5.515  SIR:   8.352  ISR:  12.376  SAR:   6.606
    other           ==> SDR:   3.667  SIR:   3.124  ISR:   6.302  SAR:   4.585

UMXL streaming architecture with quantized weights:
    vocals          ==> SDR:   5.552  SIR:  10.400  ISR:  13.089  SAR:   5.969
    drums           ==> SDR:   6.402  SIR:  11.153  ISR:  10.102  SAR:   7.653
    bass            ==> SDR:   5.368  SIR:   8.419  ISR:  10.691  SAR:   6.393
    other           ==> SDR:   3.992  SIR:   3.361  ISR:   8.008  SAR:   5.056
```

### Roadmap

- Implement Wiener Expectation-Maximization post-processing (adds ~1 dB performance overall); see [umx.cpp issue #1](https://github.com/sevagh/umx.cpp/issues/1)
- Implement demucs v4 (hybrid transformer, `htdemucs`) and the 6-source (`htdemucs_6s`) variants

### Dev instructions

Clone the repo with submodules:
```
git clone --recurse-submodules https://github.com/sevagh/free-music-demixer
```

To generate a weights file with Python, first create a Python venv, then:
```
python -m pip install -r ./scripts/requirements.txt
python ./scripts/convert-pth-to-ggml.py --model=umxl ./ggml-umxl
gzip -k ./ggml-umxl/ggml-model-umxhl-u8.bin
```

Build for WebAssembly with Emscripten using `emcmake`:
```
mkdir -p build-wasm && cd build-wasm && emcmake cmake .. && make
```
Build a regular library and the `file_demixer` binary (only tested on Linux):
```
mkdir -p build-cpp && cd build-cpp && cmake .. && make
```

### Notes

The [wav-file-encoder](https://github.com/chdh/wav-file-encoder) project has been vendored in; I manually compiled the Typescript file to Javascript with these commands:
```
npm install typescript
npx tsc --module es6 ../vendor/wav-file-encoder/src/WavFileEncoder.ts
```

### Output quality

MUSDB18-HQ test track 'Zeno - Signs':

'Zeno - Signs':
```
vocals          ==> SDR:   6.846  SIR:  16.382  ISR:  13.897  SAR:   7.024
drums           ==> SDR:   7.679  SIR:  14.462  ISR:  12.606  SAR:   9.001
bass            ==> SDR:   2.386  SIR:   4.504  ISR:   5.802  SAR:   3.731
other           ==> SDR:   6.020  SIR:   9.854  ISR:  11.963  SAR:   7.472
```

Previous release results on 'Zeno - Signs' (no streaming LSTM, no Wiener filtering):
```
vocals          ==> SDR:   6.550  SIR:  14.583  ISR:  13.820  SAR:   6.974
drums           ==> SDR:   6.538  SIR:  11.209  ISR:  11.163  SAR:   8.317
bass            ==> SDR:   1.646  SIR:   0.931  ISR:   5.261  SAR:   2.944
other           ==> SDR:   5.190  SIR:   6.623  ISR:  10.221  SAR:   8.599
```

### Memory usage

* Invented streaming UMX LSTM module for longer tracks
* Now trying entire Demucs segmentation pipeline

Steps:
1. Bundle reusable buffers together in inference.hpp/cpp
1. Use bundle from wasm_glue, pass into umx_inference
1. Implement demucs chunking
    1. Use demucs chunking to delete/eliminate wiener windowing
    1. Use demucs chunking to influence or implement streaming lstm

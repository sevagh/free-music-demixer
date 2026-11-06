import { encodeWavFileFromAudioBuffer } from './WavFileEncoder.js';

export function sumSegments(segments, desiredLength, overlapSamples) {
    const totalLength = desiredLength;
    const segmentLengthWithPadding = segments[0][0].length;
    const actualSegmentLength = segmentLengthWithPadding - 2 * overlapSamples;
    const output = new Array(segments[0].length).fill().map(() => new Float32Array(totalLength));

    // Create weights for the segment
    const weight = new Float32Array(actualSegmentLength);
    for (let i = 0; i < actualSegmentLength; i++) {
        weight[i] = (i + 1);
        weight[actualSegmentLength - 1 - i] = (i + 1);
    }
    // normalize by its max coefficient
    const maxWeight = weight.reduce((max, x) => Math.max(max, x), -Infinity);
    const ramp = weight.map(x => x / maxWeight);

    const sumWeight = new Float32Array(totalLength).fill(0);

    segments.forEach((segment, index) => {
        const start = index * actualSegmentLength;

        for (let target = 0; target < segment.length; target++) {
            const channelSegment = segment[target];

            for (let i = 0; i < channelSegment.length; i++) {
                const segmentPos = i - overlapSamples;
                const outputIndex = start + segmentPos;

                if (outputIndex >= 0 && outputIndex < totalLength) {
                    output[target][outputIndex] += ramp[i % actualSegmentLength] * channelSegment[i];
                    // accumulate weight n_targets times
                    sumWeight[outputIndex] += ramp[i % actualSegmentLength];
                }
            }
        }
    });

    // Normalize the output by the sum of weights
    for (let target = 0; target < output.length; target++) {
        for (let i = 0; i < totalLength; i++) {
            if (sumWeight[i] !== 0) {
                // divide by sum of weights with 1/n_targets adjustment
                output[target][i] /= (sumWeight[i]/(output.length));
            }
        }
    }

    return output;
}

function segmentWaveform(left, right, n_segments, overlapSamples) {
    const totalLength = left.length;
    const segmentLength = Math.ceil(totalLength / n_segments);
    const segments = [];

    for (let i = 0; i < n_segments; i++) {
        const start = i * segmentLength;
        const end = Math.min(totalLength, start + segmentLength);
        const leftSegment = new Float32Array(end - start + 2 * overlapSamples);
        const rightSegment = new Float32Array(end - start + 2 * overlapSamples);

        // Overlap-padding for the left and right channels
        // For the first segment, no padding at the start
        if (i === 0) {
            leftSegment.fill(left[0], 0, overlapSamples);
            rightSegment.fill(right[0], 0, overlapSamples);
        } else {
            leftSegment.set(left.slice(start - overlapSamples, start), 0);
            rightSegment.set(right.slice(start - overlapSamples, start), 0);
        }

        // For the last segment, no padding at the end
        if (i === n_segments - 1) {
            const remainingSamples = totalLength - end;
            leftSegment.set(left.slice(end, end + Math.min(overlapSamples, remainingSamples)), end - start + overlapSamples);
            rightSegment.set(right.slice(end, end + Math.min(overlapSamples, remainingSamples)), end - start + overlapSamples);
        } else {
            leftSegment.set(left.slice(end, end + overlapSamples), end - start + overlapSamples);
            rightSegment.set(right.slice(end, end + overlapSamples), end - start + overlapSamples);
        }

        // Assign the original segment data
        leftSegment.set(left.slice(start, end), overlapSamples);
        rightSegment.set(right.slice(start, end), overlapSamples);

        segments.push([leftSegment, rightSegment]);
    }

    return segments;
}

export function processSegments(workers, leftChannel, rightChannel, numSegments, originalLength, overlapSamples, filename = null) {
    let segments = segmentWaveform(leftChannel, rightChannel, numSegments, overlapSamples);

    segments.forEach((segment, index) => {
        workers[index].postMessage({
            msg: filename ? 'PROCESS_AUDIO_BATCH' : 'PROCESS_AUDIO',
            leftChannel: segment[0],
            rightChannel: segment[1],
            originalLength,
            ...(filename && { filename })
        });
    });
}

export function fetchAndCacheFiles(model, components, onProgress = null, dlPrefix = "models") {
    let modelFiles = [];
    if (model === 'demucs-free-4s') {
        modelFiles.push('htdemucs.ort.gz');
    } else if (model === 'demucs-free-6s') {
        modelFiles.push('htdemucs_6s.ort.gz');
    } else if (model === 'demucs-karaoke') {
        modelFiles.push('htdemucs_2s_cust.ort.gz');
    } else if (model === 'demucs-pro-ft' || model === 'demucs-pro-deluxe') {
        if (components.includes('drums')) {
            modelFiles.push('htdemucs_ft_drums.ort.gz');
        }
        if (components.includes('bass')) {
            modelFiles.push('htdemucs_ft_bass.ort.gz');
        }
        if (components.includes('melody')) {
            modelFiles.push('htdemucs_ft_other.ort.gz');
        }
        if (components.includes('vocals')) {
            modelFiles.push(model === 'demucs-pro-ft' ? 'htdemucs_ft_vocals.ort.gz' : 'htdemucs_2s_cust.ort.gz');
        }
    } else if (model === 'demucs-pro-cust') {
        modelFiles.push('htdemucs_ft_vocals.ort.gz');
        modelFiles.push('htdemucs_6s.ort.gz');
    } else if (model === 'demucs-pro-cust-spec') {
        modelFiles.push('htdemucs_2s_cust.ort.gz');
        modelFiles.push('htdemucs_ft_drums.ort.gz');
        modelFiles.push('htdemucs_ft_bass.ort.gz');
        modelFiles.push('htdemucs_6s.ort.gz');
    }

    // prepend raw gh url to all modelFiles
    modelFiles = modelFiles.map(file =>
        `${dlPrefix}/${file}`
    )

    // Track progress for each file
    const progressTracker = {
        totalProgress: 0,
        fileProgress: new Array(modelFiles.length).fill(0),
        updateProgress: function(fileIndex, progress) {
            // Update this file's progress
            this.fileProgress[fileIndex] = progress;

            // Calculate total progress as average of all files
            const newTotal = this.fileProgress.reduce((a, b) => a + b, 0) / this.fileProgress.length;

            // Only update if new total is greater than previous
            if (newTotal > this.totalProgress) {
                this.totalProgress = newTotal;
                return true;
            }
            return false;
        }
    };

    const fetchPromises = modelFiles.map((file, fileIndex) => {
        return fetch(file)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Failed to fetch ${file}`);
                }

                const total = parseInt(response.headers.get('content-length'), 10);
                let loaded = 0;

                const reader = response.body.getReader();
                return new Response(
                    new ReadableStream({
                        async start(controller) {
                            while (true) {
                                const {done, value} = await reader.read();
                                if (done) break;

                                loaded += value.length;
                                const fileProgress = (loaded / total) * 100;

                                // Only call onProgress if total progress actually increased
                                if (onProgress && progressTracker.updateProgress(fileIndex, fileProgress)) {
                                    onProgress(progressTracker.totalProgress);
                                }

                                controller.enqueue(value);
                            }
                            controller.close();
                        }
                    })
                ).arrayBuffer();
            });
    });

  return Promise.all(fetchPromises);
}

export function computeModelAndStems(processingMode, selectedFeatures, selectedQuality) {
    // 1) If strictly MIDI mode, short-circuit
    if (processingMode === 'midi') {
      return {
        model: 'basicpitch',
        stems: [] // or however you handle stems in midi-only
      };
    }

    // Default textual label
    let selectedModelLocal = "4-SOURCE (FREE)";

    // 2) Determine model label by rules
    if (selectedFeatures.includes("piano") || selectedFeatures.includes("guitar") || selectedFeatures.includes("other_melody")) {
      // Rule 1
      if (selectedQuality === "default") {
        selectedModelLocal = "6-SOURCE (PRO)";
      } else if (selectedQuality === "medium") {
        selectedModelLocal = "CUSTOM (PRO)";
      } else if (selectedQuality === "high") {
        selectedModelLocal = "CUSTOM SPECIAL (PRO)";
      }
    } else if (selectedFeatures.every(item => ["vocals", "instrumental"].includes(item))) {
      // Rule 2
      if (selectedQuality === "default") {
        selectedModelLocal = "4-SOURCE (FREE)";
      } else if (selectedQuality === "medium") {
        selectedModelLocal = "FINE-TUNED (PRO)";
      } else if (selectedQuality === "high") {
        selectedModelLocal = "KARAOKE (PRO)";
      }
    } else if (selectedFeatures.some(item => ["vocals", "drums", "bass", "melody"].includes(item))) {
      // Rule 3
      if (selectedQuality === "default") {
        selectedModelLocal = "4-SOURCE (FREE)";
      } else if (selectedQuality === "medium") {
        selectedModelLocal = "FINE-TUNED (PRO)";
      } else if (selectedQuality === "high") {
        selectedModelLocal = "DELUXE (PRO)";
      }
    }

    // 3) Convert textual label => internal model ID
    let model = '';
    switch (selectedModelLocal) {
      case "4-SOURCE (FREE)":
        model = 'demucs-free-4s';
        break;
      case "6-SOURCE (PRO)":
        model = 'demucs-free-6s';
        break;
      case "FINE-TUNED (PRO)":
        model = 'demucs-pro-ft';
        break;
      case "KARAOKE (PRO)":
        model = 'demucs-karaoke';
        break;
      case "CUSTOM (PRO)":
        model = 'demucs-pro-cust';
        break;
      case "DELUXE (PRO)":
        model = 'demucs-pro-deluxe';
        break;
      case "CUSTOM SPECIAL (PRO)":
        model = 'demucs-pro-cust-spec';
        break;
    }

    // 4) Copy the user’s stems
    let stems = [...selectedFeatures];

    // If stems includes "instrumental" but model != demucs-karaoke => expand
    if (stems.includes('instrumental') && model !== 'demucs-karaoke') {
      if (['demucs-free-4s', 'demucs-pro-ft', 'demucs-pro-deluxe'].includes(model)) {
        if (!stems.includes('drums')) stems.push('drums');
        if (!stems.includes('bass')) stems.push('bass');
        if (!stems.includes('melody')) stems.push('melody');
      }
      if (['demucs-free-6s', 'demucs-pro-cust', 'demucs-pro-cust-spec'].includes(model)) {
        if (!stems.includes('drums')) stems.push('drums');
        if (!stems.includes('bass')) stems.push('bass');
        if (!stems.includes('other_melody')) stems.push('other_melody');
        if (!stems.includes('guitar')) stems.push('guitar');
        if (!stems.includes('piano')) stems.push('piano');
      }
    }

    // If stems includes "melody" & model in big-6 => expand
    if (stems.includes('melody') && ['demucs-free-6s', 'demucs-pro-cust', 'demucs-pro-cust-spec'].includes(model)) {
      if (!stems.includes('other_melody')) stems.push('other_melody');
      if (!stems.includes('guitar')) stems.push('guitar');
      if (!stems.includes('piano')) stems.push('piano');
    }

    // 5) Sort stems
    stems.sort((a, b) => {
      const order = ["drums", "bass", "melody", "vocals", "guitar", "piano", "instrumental"];
      return order.indexOf(a) - order.indexOf(b);
    });

    return { model, stems };
  }

export function openSheetMusicInNewTab(mxmlData, instrumentName) {
  const newTab = window.open("", "_blank");
  if (!newTab) {
    alert("Please allow pop-ups to see your sheet music.");
    return;
  }

  // Convert the raw bytes into a string using TextDecoder.
  // The assumption is that `mxmlData` is a Uint8Array or ArrayBuffer.
  const decoder = new TextDecoder();
  // Ensure mxmlData is a Uint8Array if it's an ArrayBuffer
  let typedArray = mxmlData instanceof Uint8Array ? mxmlData : new Uint8Array(mxmlData);
  const xmlString = decoder.decode(typedArray);

  // Write an HTML structure into the new window
  newTab.document.write(`
    <html>
    <head>
      <title>Sheet Music: ${instrumentName}</title>
      <style>
        body {
          margin: 0;
          padding: 0;
          font-family: sans-serif;
        }
        #osmdContainer {
          width: 100%;
          height: calc(100% - 50px);
          box-sizing: border-box;
        }
        #controls {
          display: flex;
          gap: 10px;
          align-items: center;
          padding: 10px;
          background: #f0f0f0;
          border-bottom: 1px solid #ddd;
        }
        button {
          cursor: pointer;
        }
      </style>
    </head>
    <body>
      <div id="controls">
        <button id="saveBtn">Save</button>
        <button id="printBtn">Print</button>
      </div>
      <div id="osmdContainer"></div>

      <!-- Load OpenSheetMusicDisplay via CDN: choose a stable version or the latest -->
      <script src="https://cdn.jsdelivr.net/npm/opensheetmusicdisplay@1.6.1/build/opensheetmusicdisplay.min.js"></script>

      <script>
        // We load OSMD after the script is done, so we must wait for DOMContentLoaded
        document.addEventListener("DOMContentLoaded", async () => {
          const osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay("osmdContainer", {
            // any OSMD options you want
            followCursor: true,
            drawMeasureNumbers: true
          });

          try {
            const xml = \`${xmlString.replace(/`/g, "\\`")}\`;
            await osmd.load(xml);
            osmd.render();
          } catch (error) {
            console.error("OSMD load error:", error);
          }

          // Save Button - downloads the MusicXML
          document.getElementById("saveBtn").addEventListener("click", () => {
            const blob = new Blob([\`${xmlString.replace(/`/g, "\\`")}\`], {
              type: "application/vnd.recordare.musicxml+xml"
            });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = "${instrumentName}.musicxml";
            a.click();
            URL.revokeObjectURL(url);
          });

          // Print Button
          document.getElementById("printBtn").addEventListener("click", () => {
            window.print();
          });
        });
      </script>
    </body>
    </html>
  `);

  // Must close the document to finish writing
  newTab.document.close();
}

export class MidiWorkerManager {
  constructor({
    workerScript = 'midi-worker.js',
    wasmScript = 'basicpitch_mxml.js',
    basicpitchAudioContext,
    trackProductEvent,
    encodeWavFileFromAudioBuffer,
  }) {
    this.workerScript = workerScript;
    this.wasmScript = wasmScript;
    this.basicpitchAudioContext = basicpitchAudioContext;
    this.trackProductEvent = trackProductEvent;
    this.encodeWavFileFromAudioBuffer = encodeWavFileFromAudioBuffer;

    // Internal state
    this.midiQueue = [];
    this.isProcessing = false;
    this.midiWorker = null;
    this.midiWasmLoaded = false;
    this.midiBuffers = {};
    this.mxmlBuffers = {};
    this.mxmlBuffersSheetMusic = {};
    this.queueTotal = 0;
    this.queueCompleted = 0;
    this.completedSongsBatchMidi = 0;

    this.batchCount = 1;
  }

  initializeMidiWorker() {
    this.midiWorker = new Worker(this.workerScript);

    this.midiWorker.onmessage = (e) => {
      if (e.data.msg === 'WASM_READY') {
        console.log('Basicpitch WASM module loaded successfully');
        this.midiWasmLoaded = true;
        this.processNextMidi();
      } else if (e.data.msg === 'PROGRESS_UPDATE') {
        const prog = e.data.data;
        const totalProgress = ((this.queueCompleted + prog) / this.queueTotal) * 100;
        document.getElementById('midi-progress-bar').style.width = `${totalProgress}%`;
      } else if (e.data.msg === 'PROGRESS_UPDATE_BATCH') {
        const prog = e.data.data;
        const fileChunk = 100 / this.batchCount;
        const startingPointForCurrentSong = this.completedSongsBatchMidi * fileChunk;
        // get old width
        const oldWidth = document.getElementById('midi-progress-bar').style.width;
        const newWidth = startingPointForCurrentSong + (prog * fileChunk);
        // only update the progress bar if the new width is greater than the old width
        if (newWidth > parseFloat(oldWidth)) {
          document.getElementById('midi-progress-bar').style.width = `${newWidth}%`;
        }
      } else if (e.data.msg === 'PROCESSING_DONE') {
        this.queueCompleted += 1;
        this.handleMidiDone(e.data);
        this.isProcessing = false;
        this.processNextMidi();
      } else if (e.data.msg === 'PROCESSING_FAILED') {
        console.error(`Failed to generate MIDI for ${e.data.stemName}.`);
        this.isProcessing = false;
        this.processNextMidi();
      }
    };

    // Load the WASM module
    this.midiWorker.postMessage({ msg: 'LOAD_WASM', scriptName: this.wasmScript });
  }

  handleMidiDone(data) {
    const { midiBytes, mxmlBytes, stemName } = data;
    const midiBlob = new Blob([midiBytes], { type: 'audio/midi' });
    this.midiBuffers[stemName] = midiBlob;
    this.mxmlBuffers[stemName] = mxmlBytes;
    this.trackProductEvent('MIDI Generation Completed', { stem: stemName });
    console.log(`MIDI generation done for ${stemName}.`);
  }

  /**
   * Queue a new MIDI job.
   */
  queueMidiRequest(audioBuffer, stemName, batchCount, directArrayBuffer = false) {
    this.batchCount = batchCount;
    this.midiQueue.push({ audioBuffer, stemName, batchCount, directArrayBuffer });
    this.queueTotal += 1;
    this.processNextMidi();
  }

  /**
   * Process next item if we're not busy and WASM is ready.
   */
  processNextMidi() {
    if (this.isProcessing || this.midiQueue.length === 0 || !this.midiWasmLoaded) return;

    this.isProcessing = true;
    const { audioBuffer, stemName, batchCount, directArrayBuffer } = this.midiQueue.shift();
    this.generateMidi(audioBuffer, stemName, batchCount, directArrayBuffer);
  }

  /**
   * The core function that does "encode if needed, decode to mono, postMessage to worker."
   */
  generateMidi(inputBuffer, stemName, batchCount, directArrayBuffer = false) {
    this.trackProductEvent('MIDI Generation Started', { stem: stemName });
    const batchMode = batchCount > 1;

    const postToWorker = (monoAudioData) => {
      this.midiWorker.postMessage({
        msg: 'PROCESS_AUDIO',
        inputData: monoAudioData.buffer,
        length: monoAudioData.length,
        stemName,
        batchMode,
      }, [monoAudioData.buffer]); // Transfer ownership
    };

    if (directArrayBuffer) {
      this.basicpitchAudioContext.decodeAudioData(inputBuffer, decodedData => {
        const leftChannel = decodedData.getChannelData(0);
        const rightChannel = (decodedData.numberOfChannels > 1) ? decodedData.getChannelData(1) : leftChannel;
        const monoAudioData = new Float32Array(leftChannel.length);

        for (let i = 0; i < leftChannel.length; i++) {
          monoAudioData[i] = (leftChannel[i] + rightChannel[i]) / 2.0;
        }
        postToWorker(monoAudioData);
      });
    } else {
      const wavArrayBuffer = this.encodeWavFileFromAudioBuffer(inputBuffer, 0);
      this.basicpitchAudioContext.decodeAudioData(wavArrayBuffer, decodedData => {
        const leftChannel = decodedData.getChannelData(0);
        const rightChannel = (decodedData.numberOfChannels > 1) ? decodedData.getChannelData(1) : leftChannel;
        const monoAudioData = new Float32Array(leftChannel.length);

        for (let i = 0; i < leftChannel.length; i++) {
          monoAudioData[i] = (leftChannel[i] + rightChannel[i]) / 2.0;
        }
        postToWorker(monoAudioData);
      });
    }
  }

  /**
   * Wait for entire MIDI queue to be processed (i.e. no pending items or current processing).
   */
  waitForMidiProcessing() {
    return new Promise(resolve => {
      const checkQueueCompletion = () => {
        if (this.midiQueue.length === 0 && !this.isProcessing) {
          resolve(); // All MIDI files are processed
        } else {
          setTimeout(checkQueueCompletion, 100);
        }
      };
      checkQueueCompletion();
    });
  }
}

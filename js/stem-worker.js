let modelName;
let selectedStems;
let modelBuffers;

function loadWASMModule() {
    // Assuming the demucs.js script automatically initializes the WASM module
    try {
        importScripts("demucs_onnx_simd.js");
        let wasmModule = libdemucs();
        return wasmModule;
    } catch (error) {
        console.error("Error loading WASM module script:", error);
        return null;
    }
}

function getNumModelsFromModelName() {
    let numModels = 1; // default case for free-4s, free-6s, karaoke
    if (modelName === 'demucs-pro-ft' || modelName === 'demucs-pro-deluxe') {
        numModels = selectedStems.length;
    } else if (modelName === 'demucs-pro-cust') {
        numModels = 2;
    } else if (modelName === 'demucs-pro-cust-spec') {
        numModels = 4;
    }
    return numModels;
}

function getNumTargetsFromModelName() {
    // base case for free-4s
    let numTargets = [4];
    if (modelName === 'demucs-free-6s') {
        // demucs-free-6s has 6 targets
        numTargets = [6];
    } else if (modelName === 'demucs-karaoke') {
        // demucs-karaoke has 2 targets
        numTargets = [2];
    } else if (modelName === 'demucs-pro-ft' || modelName === 'demucs-pro-deluxe') {
        numTargets = [];
        for (let i = 0; i < selectedStems.length; i++) {
            if (selectedStems[i] === 'drums') {
                numTargets.push(4);
            } else if (selectedStems[i] === 'bass') {
                numTargets.push(4);
            } else if (selectedStems[i] === 'melody') {
                numTargets.push(4);
            } else if (selectedStems[i] === 'vocals') {
                numTargets.push(modelName === 'demucs-pro-ft' ? 4 : 2);
            }
        }
    }

    // demucs-pro-cust as an ensemble model outputs 7 targets
    // however, those outputs are created from other models
    // so it's a special case and we don't need to consider it here
    return numTargets;
}

// Define the onmessage event listener
onmessage = async function(e) {
    if (e.data.msg === 'LOAD_WASM') {
        modelName = e.data.model;
        // filter out 'instrumental' from selectedStems
        selectedStems = e.data.stems.filter(stem => stem !== 'instrumental');

        // if modelName is demucs-free-6s or demucs-pro-cust, filter our melody
        if (modelName === 'demucs-free-6s' || modelName === 'demucs-pro-cust') {
            selectedStems = selectedStems.filter(stem => stem !== 'melody');
        }
        modelBuffers = e.data.modelBuffers;
    } else if (e.data.msg === 'PROCESS_AUDIO' || e.data.msg === 'PROCESS_AUDIO_BATCH') {
        console.log(`Started demix job at ${new Date().toString()}`);

        const leftChannel = e.data.leftChannel;
        const rightChannel = e.data.rightChannel;

        const modelTotal = getNumModelsFromModelName();
        let modelTotalWithAugmentations = modelTotal;

        let invert = false;
        // we invert waveform for deluxe (4 models 8 inferences), custom (3 models 6 inferences), and karaoke (1 model 2 inferences)
        if (modelName === 'demucs-pro-deluxe' || modelName === 'demucs-pro-cust' || modelName === 'demucs-karaoke' || modelName === 'demucs-pro-cust-spec') {
            console.log("Using augmented inference for model:", modelName);
            invert = true;
            modelTotalWithAugmentations *= 2;
        }

        let inferenceResults = [];
        console.log("Model name is:", modelName);
        console.log("Selected stems are:", selectedStems);

        // modelBuffers is already an array of array buffers sent from the main thread
        // Directly prepare data for initialization
        const modelDataArray = modelBuffers.map(buffer => new Uint8Array(buffer));

        // easy way to do sequential processing of each wasmModule
        if (modelName != 'demucs-pro-cust' && modelName != 'demucs-pro-cust-spec') {
            let numTargets = getNumTargetsFromModelName();
            for (let i = 0; i < modelTotal; i++) {
                let loadedModule = await loadWASMModule();
                if (!loadedModule) {
                    console.error("Error loading WASM module");
                    return;
                }

                const modelDataPtr = loadedModule._malloc(modelDataArray[i].byteLength);
                loadedModule.HEAPU8.set(modelDataArray[i], modelDataPtr);
                loadedModule._modelInit(modelDataPtr, modelDataArray[i].byteLength);
                loadedModule._free(modelDataPtr);

                let targetWaveforms;
                const batch = e.data.msg === 'PROCESS_AUDIO_BATCH';
                let indexInModel = invert ? i * 2 : i;
                targetWaveforms = processAudio(leftChannel, rightChannel, loadedModule, numTargets[i], batch, modelTotalWithAugmentations, indexInModel);

                // if we need to invert the waveform, we do it here
                if (invert) {
                    invertedLeftChannel = leftChannel.map(x => -x);
                    invertedRightChannel = rightChannel.map(x => -x);
                    invertedTargetWaveforms = processAudio(invertedLeftChannel, invertedRightChannel, loadedModule, numTargets[i], batch, modelTotalWithAugmentations, indexInModel + 1);
                    // now invert the targetWaveforms
                    invertInvertTargetWaveforms = invertedTargetWaveforms.map(arr => arr.map(x => -x));

                    // now sum and average with the original targetWaveforms
                    targetWaveforms = targetWaveforms.map((arr, idx) => arr.map((x, inner_idx) => (x + invertInvertTargetWaveforms[idx][inner_idx]) / 2.0));
                }

                inferenceResults.push(targetWaveforms);
                loadedModule = null;
            }
        } else if (modelName === 'demucs-pro-cust') {
            // medium quality = budget of 4 inferences

            // ensemble logic for demucs-pro-cust
            let loadedModule = await loadWASMModule();
            if (!loadedModule) {
                console.error("Error loading WASM module");
                return;
            }

            const model1DataPtr = loadedModule._malloc(modelDataArray[0].byteLength);
            loadedModule.HEAPU8.set(modelDataArray[0], model1DataPtr);
            loadedModule._modelInit(model1DataPtr, modelDataArray[0].byteLength);
            loadedModule._free(model1DataPtr);

            let targetWaveforms1;
            const batch = e.data.msg === 'PROCESS_AUDIO_BATCH';
            targetWaveforms1 = processAudio(
                leftChannel, rightChannel, loadedModule, 4, batch, modelTotalWithAugmentations, 0);

            invertedLeftChannel1 = leftChannel.map(x => -x);
            invertedRightChannel1 = rightChannel.map(x => -x);
            let invertedTargetWaveforms1 = processAudio(invertedLeftChannel1, invertedRightChannel1, loadedModule, 4, batch, modelTotalWithAugmentations, 1);
            // now invert the targetWaveforms
            let invertInvertTargetWaveforms1 = invertedTargetWaveforms1.map(arr => arr.map(x => -x));

            // now sum and average with the original targetWaveforms
            targetWaveforms1 = targetWaveforms1.map(
                (arr, idx) => arr.map((x, inner_idx) => (x + invertInvertTargetWaveforms1[idx][inner_idx]) / 2.0));

            // now we have the final vocals
            // create intermediateAccompaniment by subtracting vocals from the original waveform
            let intermediateAccompanimentL = leftChannel.map((x, idx) => x - targetWaveforms1[6][idx]);
            let intermediateAccompanimentR = rightChannel.map((x, idx) => x - targetWaveforms1[7][idx]);

            // now model 2
            loadedModule = await loadWASMModule();
            if (!loadedModule) {
                console.error("Error loading WASM module");
                return;
            }

            const model2DataPtr = loadedModule._malloc(modelDataArray[1].byteLength);
            loadedModule.HEAPU8.set(modelDataArray[1], model2DataPtr);
            loadedModule._modelInit(model2DataPtr, modelDataArray[1].byteLength);
            loadedModule._free(model2DataPtr);

            let targetWaveforms2;
            targetWaveforms2 = processAudio(
                intermediateAccompanimentL, intermediateAccompanimentR, loadedModule, 6, batch, modelTotalWithAugmentations, 2);

            // create inverted intermediate accompaniment left and right
            let invertedIntermediateAccompanimentL = intermediateAccompanimentL.map(x => -x);
            let invertedIntermediateAccompanimentR = intermediateAccompanimentR.map(x => -x);

            let invertedTargetWaveforms2 = processAudio(invertedIntermediateAccompanimentL, invertedIntermediateAccompanimentR, loadedModule, 6, batch, modelTotalWithAugmentations, 3);
            // now invert the targetWaveforms
            let invertInvertTargetWaveforms2 = invertedTargetWaveforms2.map(arr => arr.map(x => -x));

            // now sum and average with the original targetWaveforms
            targetWaveforms2 = targetWaveforms2.map((arr, idx) => arr.map((x, inner_idx) => (x + invertInvertTargetWaveforms2[idx][inner_idx]) / 2.0));

            // now we have everything we need
            let returnWaveforms = [
                targetWaveforms2[0], targetWaveforms2[1], // final drums directly from model 3
                targetWaveforms2[2], targetWaveforms2[3],   // final bass directly from model 3
                targetWaveforms2[4], targetWaveforms2[5], // final other accompaniment directly from model 3
                targetWaveforms1[6], targetWaveforms1[7], // final vocals from model 1
                targetWaveforms2[8], targetWaveforms2[9], // final guitar from model 3
                targetWaveforms2[10], targetWaveforms2[11], // final piano from model 3
            ]
            inferenceResults.push(returnWaveforms);
        } else if (modelName === 'demucs-pro-cust-spec') {
            // high quality = budget of 8 inferences
            let loadedModule = await loadWASMModule();
            if (!loadedModule) {
                console.error("Error loading WASM module");
                return;
            }

            const model1DataPtr = loadedModule._malloc(modelDataArray[0].byteLength);
            loadedModule.HEAPU8.set(modelDataArray[0], model1DataPtr);
            loadedModule._modelInit(model1DataPtr, modelDataArray[0].byteLength);
            loadedModule._free(model1DataPtr);

            let targetWaveforms1;
            const batch = e.data.msg === 'PROCESS_AUDIO_BATCH';
            targetWaveforms1 = processAudio(
                leftChannel, rightChannel, loadedModule, 2, batch, modelTotalWithAugmentations, 0);

            invertedLeftChannel1 = leftChannel.map(x => -x);
            invertedRightChannel1 = rightChannel.map(x => -x);
            let invertedTargetWaveforms1 = processAudio(invertedLeftChannel1, invertedRightChannel1, loadedModule, 2, batch, modelTotalWithAugmentations, 1);
            // now invert the targetWaveforms
            let invertInvertTargetWaveforms1 = invertedTargetWaveforms1.map(arr => arr.map(x => -x));

            // now sum and average with the original targetWaveforms
            targetWaveforms1 = targetWaveforms1.map(
                (arr, idx) => arr.map((x, inner_idx) => (x + invertInvertTargetWaveforms1[idx][inner_idx]) / 2.0));

            // now we have the final vocals
            // create intermediateAccompaniment by subtracting vocals from the original waveform
            let intermediateAccompanimentL = leftChannel.map((x, idx) => x - targetWaveforms1[0][idx]);
            let intermediateAccompanimentR = rightChannel.map((x, idx) => x - targetWaveforms1[1][idx]);

            // now model 2
            loadedModule = await loadWASMModule();
            if (!loadedModule) {
                console.error("Error loading WASM module");
                return;
            }

            const model2DataPtr = loadedModule._malloc(modelDataArray[1].byteLength);
            loadedModule.HEAPU8.set(modelDataArray[1], model2DataPtr);
            loadedModule._modelInit(model2DataPtr, modelDataArray[1].byteLength);
            loadedModule._free(model2DataPtr);

            let targetWaveforms2;
            targetWaveforms2 = processAudio(
                intermediateAccompanimentL, intermediateAccompanimentR, loadedModule, 4, batch, modelTotalWithAugmentations, 2);

            // create inverted intermediate accompaniment left and right
            let invertedIntermediateAccompanimentL = intermediateAccompanimentL.map(x => -x);
            let invertedIntermediateAccompanimentR = intermediateAccompanimentR.map(x => -x);

            let invertedTargetWaveforms2 = processAudio(invertedIntermediateAccompanimentL, invertedIntermediateAccompanimentR, loadedModule, 4, batch, modelTotalWithAugmentations, 3);
            // now invert the targetWaveforms
            let invertInvertTargetWaveforms2 = invertedTargetWaveforms2.map(arr => arr.map(x => -x));

            // now sum and average with the original targetWaveforms
            targetWaveforms2 = targetWaveforms2.map((arr, idx) => arr.map((x, inner_idx) => (x + invertInvertTargetWaveforms2[idx][inner_idx]) / 2.0));

            // this is drums that we subtract again from the intermediate accompaniment
            let intermediateAccompanimentL2 = intermediateAccompanimentL.map((x, idx) => x - targetWaveforms2[0][idx]);
            let intermediateAccompanimentR2 = intermediateAccompanimentR.map((x, idx) => x - targetWaveforms2[1][idx]);

            // now load model 3
            loadedModule = await loadWASMModule();
            if (!loadedModule) {
                console.error("Error loading WASM module");
                return;
            }

            const model3DataPtr = loadedModule._malloc(modelDataArray[2].byteLength);
            loadedModule.HEAPU8.set(modelDataArray[2], model3DataPtr);
            loadedModule._modelInit(model3DataPtr, modelDataArray[2].byteLength);
            loadedModule._free(model3DataPtr);

            let targetWaveforms3;
            targetWaveforms3 = processAudio(
                intermediateAccompanimentL2, intermediateAccompanimentR2, loadedModule, 4, batch, modelTotalWithAugmentations, 4);

            // create inverted intermediate accompaniment left and right
            let invertedIntermediateAccompanimentL2 = intermediateAccompanimentL2.map(x => -x);
            let invertedIntermediateAccompanimentR2 = intermediateAccompanimentR2.map(x => -x);

            let invertedTargetWaveforms3 = processAudio(invertedIntermediateAccompanimentL2, invertedIntermediateAccompanimentR2, loadedModule, 4, batch, modelTotalWithAugmentations, 5);

            // now invert the targetWaveforms
            let invertInvertTargetWaveforms3 = invertedTargetWaveforms3.map(arr => arr.map(x => -x));

            // now sum and average with the original targetWaveforms
            targetWaveforms3 = targetWaveforms3.map((arr, idx) => arr.map((x, inner_idx) => (x + invertInvertTargetWaveforms3[idx][inner_idx]) / 2.0));

            // this is the bass that we subtract again from the intermediate accompaniment
            let intermediateAccompanimentL3 = intermediateAccompanimentL2.map((x, idx) => x - targetWaveforms3[2][idx]);
            let intermediateAccompanimentR3 = intermediateAccompanimentR2.map((x, idx) => x - targetWaveforms3[3][idx]);

            // now load model 4, finally this is the 6s that will create guitar and piano

            loadedModule = await loadWASMModule();
            if (!loadedModule) {
                console.error("Error loading WASM module");
                return;
            }

            const model4DataPtr = loadedModule._malloc(modelDataArray[3].byteLength);
            loadedModule.HEAPU8.set(modelDataArray[3], model4DataPtr);
            loadedModule._modelInit(model4DataPtr, modelDataArray[3].byteLength);
            loadedModule._free(model4DataPtr);

            let targetWaveforms4;
            targetWaveforms4 = processAudio(
                intermediateAccompanimentL3, intermediateAccompanimentR3, loadedModule, 6, batch, modelTotalWithAugmentations, 6);

            // create inverted intermediate accompaniment left and right
            let invertedIntermediateAccompanimentL3 = intermediateAccompanimentL3.map(x => -x);
            let invertedIntermediateAccompanimentR3 = intermediateAccompanimentR3.map(x => -x);

            let invertedTargetWaveforms4 = processAudio(invertedIntermediateAccompanimentL3, invertedIntermediateAccompanimentR3, loadedModule, 6, batch, modelTotalWithAugmentations, 7);

            // now invert the targetWaveforms
            let invertInvertTargetWaveforms4 = invertedTargetWaveforms4.map(arr => arr.map(x => -x));

            // now sum and average with the original targetWaveforms
            targetWaveforms4 = targetWaveforms4.map((arr, idx) => arr.map((x, inner_idx) => (x + invertInvertTargetWaveforms4[idx][inner_idx]) / 2.0));

            // now we have everything we need
            let returnWaveforms = [
                targetWaveforms2[0], targetWaveforms2[1], // final drums directly from model 2
                targetWaveforms3[2], targetWaveforms3[3], // final bass directly from model 3
                targetWaveforms4[4], targetWaveforms4[5], // final other accompaniment directly from model 3
                targetWaveforms1[0], targetWaveforms1[1], // final vocals from model 1
                targetWaveforms4[8], targetWaveforms4[9], // final guitar from model 3
                targetWaveforms4[10], targetWaveforms4[11], // final piano from model 3
            ]
            inferenceResults.push(returnWaveforms);
        }

        // now, we have all the results in inferenceResults
        // apply a postprocessing function that has per-model logic
        let finalWaveforms;

        // now inferenceResults[0] has the results for the first model
        // for karaoke, free-4s, free-6s (single-model models), we're done
        if (modelName === 'demucs-karaoke') {
            finalWaveforms = inferenceResults[0];
        }
        else if (modelName === 'demucs-free-4s') {
            // construct finalWaveforms from inferenceResults
            finalWaveforms = [];
            // iterate over selectedStems
            for (let i = 0; i < selectedStems.length; i++) {
                if (selectedStems[i] === 'drums') {
                    finalWaveforms.push(inferenceResults[0][0], inferenceResults[0][1]);
                } else if (selectedStems[i] === 'bass') {
                    finalWaveforms.push(inferenceResults[0][2], inferenceResults[0][3]);
                } else if (selectedStems[i] === 'melody') {
                    finalWaveforms.push(inferenceResults[0][4], inferenceResults[0][5]);
                } else if (selectedStems[i] === 'vocals') {
                    finalWaveforms.push(inferenceResults[0][6], inferenceResults[0][7]);
                }
            }
        }
        else if (modelName === 'demucs-free-6s' || modelName === 'demucs-pro-cust' || modelName === 'demucs-pro-cust-spec') {
            // construct finalWaveforms from inferenceResults
            finalWaveforms = [];
            // iterate over selectedStems
            for (let i = 0; i < selectedStems.length; i++) {
                if (selectedStems[i] === 'drums') {
                    finalWaveforms.push(inferenceResults[0][0], inferenceResults[0][1]);
                } else if (selectedStems[i] === 'bass') {
                    finalWaveforms.push(inferenceResults[0][2], inferenceResults[0][3]);
                } else if (selectedStems[i] === 'other_melody') {
                    finalWaveforms.push(inferenceResults[0][4], inferenceResults[0][5]);
                } else if (selectedStems[i] === 'vocals') {
                    finalWaveforms.push(inferenceResults[0][6], inferenceResults[0][7]);
                } else if (selectedStems[i] === 'guitar') {
                    finalWaveforms.push(inferenceResults[0][8], inferenceResults[0][9]);
                } else if (selectedStems[i] === 'piano') {
                    finalWaveforms.push(inferenceResults[0][10], inferenceResults[0][11]);
                }
            }
        }
        // pro finetuned is straightforward: 4 models,  4 targets
        // we extract each target from the separate models e.g. final bass = model 1 bass, final drums = model 2 drums, etc.
        else if (modelName === 'demucs-pro-ft') {
            // construct finalWaveforms from inferenceResults
            finalWaveforms = [];
            // iterate over selectedStems
            for (let i = 0; i < selectedStems.length; i++) {
                if (selectedStems[i] === 'drums') {
                    finalWaveforms.push(inferenceResults[i][0], inferenceResults[i][1]);
                } else if (selectedStems[i] === 'bass') {
                    finalWaveforms.push(inferenceResults[i][2], inferenceResults[i][3]);
                } else if (selectedStems[i] === 'melody') {
                    finalWaveforms.push(inferenceResults[i][4], inferenceResults[i][5]);
                } else if (selectedStems[i] === 'vocals') {
                    finalWaveforms.push(inferenceResults[i][6], inferenceResults[i][7]);
                }
            }
        }
        // pro deluxe is similar except vocals was from a 2-stem model, so we take its first two l/r, not index 6/7
        // we extract each target from the separate models e.g. final bass = model 1 bass, final drums = model 2 drums, etc.
        else if (modelName === 'demucs-pro-deluxe') {
            // construct finalWaveforms from inferenceResults
            finalWaveforms = [];
            // iterate over selectedStems
            for (let i = 0; i < selectedStems.length; i++) {
                if (selectedStems[i] === 'drums') {
                    finalWaveforms.push(inferenceResults[i][0], inferenceResults[i][1]);
                } else if (selectedStems[i] === 'bass') {
                    finalWaveforms.push(inferenceResults[i][2], inferenceResults[i][3]);
                } else if (selectedStems[i] === 'melody') {
                    finalWaveforms.push(inferenceResults[i][4], inferenceResults[i][5]);
                } else if (selectedStems[i] === 'vocals') {
                    finalWaveforms.push(inferenceResults[i][0], inferenceResults[i][1]);
                }
            }
        }

        const transferList = finalWaveforms.map(arr => arr.buffer);

        console.log(`Finished demix job at ${new Date().toString()}`);
        postMessage({
            msg: e.data.msg === 'PROCESS_AUDIO' ? 'PROCESSING_DONE' : 'PROCESSING_DONE_BATCH',
            waveforms: finalWaveforms,
            originalLength: e.data.originalLength,
            filename: e.data.msg === 'PROCESS_AUDIO' ? "" : e.data.filename,
        }, transferList);
    }
};

const MAX_TARGETS = 6; // Adjust based on the maximum number of targets

/**
 * Allocates memory for a Float32Array in WASM and sets its data.
 * @param {WASMModule} module - The loaded WASM module.
 * @param {Float32Array} data - The audio channel data.
 * @returns {number} - The pointer to the allocated memory in WASM.
 */
function allocateWasmArray(module, data) {
    const byteLength = data.length * data.BYTES_PER_ELEMENT;
    const ptr = module._malloc(byteLength);
    if (ptr === 0) {
        throw new Error('Memory allocation failed');
    }
    const wasmArray = new Float32Array(module.HEAPF32.buffer, ptr, data.length);
    wasmArray.set(data);
    return ptr;
}

/**
 * Frees allocated WASM memory.
 * @param {WASMModule} module - The loaded WASM module.
 * @param {number[]} pointers - Array of memory pointers to free.
 */
function freeWasmMemory(module, pointers) {
    pointers.forEach(ptr => {
        if (ptr !== null && ptr !== 0) {
            module._free(ptr);
        }
    });
}

/**
 * Processes audio using the WASM module.
 * @param {Float32Array} leftChannel - The left audio channel data.
 * @param {Float32Array} rightChannel - The right audio channel data.
 * @param {WASMModule} module - The loaded WASM module.
 * @param {number} numTargets - Number of targets to process.
 * @param {boolean} batch - Batch processing flag.
 * @param {number} modelTotal - Total number of models.
 * @param {number} indexInModel - Current model index.
 * @returns {Float32Array[]} - Array of processed waveforms.
 */
function processAudio(leftChannel, rightChannel, module, numTargets, batch, modelTotal, indexInModel) {
    try {
        // Allocate memory for input channels
        const inputPointers = [
            allocateWasmArray(module, leftChannel),
            allocateWasmArray(module, rightChannel)
        ];

        // Prepare pointers for target outputs
        const targetPointers = [];

        for (let i = 0; i < MAX_TARGETS; i++) {
            if (i < numTargets) {
                // Allocate memory for this target's left and right channels
                const ptrL = module._malloc(leftChannel.length * leftChannel.BYTES_PER_ELEMENT);
                const ptrR = module._malloc(rightChannel.length * rightChannel.BYTES_PER_ELEMENT);
                if (ptrL === 0 || ptrR === 0) {
                    throw new Error(`Memory allocation failed for target ${i}`);
                }
                targetPointers.push(ptrL, ptrR);
            } else {
                // Pass null pointers for unused targets
                targetPointers.push(0, 0);
            }
        }

        // Combine all pointers into a single arguments array
        // The WASM function signature is assumed to be:
        // _modelDemixSegment(inputL, inputR, length, target1L, target1R, target2L, target2R, ..., batch, modelTotal, indexInModel)
        const wasmArgs = [
            inputPointers[0],
            inputPointers[1],
            leftChannel.length
        ];

        // Add target pointers in order
        wasmArgs.push(...targetPointers);

        // Add additional parameters
        wasmArgs.push(batch, modelTotal, indexInModel);

        // Call the WASM function with all arguments
        module._modelDemixSegment(...wasmArgs);

        // Retrieve the processed data from WASM memory
        const processedWaveforms = [];

        for (let i = 0; i < numTargets; i++) {
            const ptrL = targetPointers[i * 2];
            const ptrR = targetPointers[i * 2 + 1];
            if (ptrL !== 0 && ptrR !== 0) {
                const waveformL = new Float32Array(module.HEAPF32.buffer, ptrL, leftChannel.length);
                const waveformR = new Float32Array(module.HEAPF32.buffer, ptrR, rightChannel.length);
                processedWaveforms.push(new Float32Array(waveformL));
                processedWaveforms.push(new Float32Array(waveformR));
            }
        }

        // Free all allocated memory
        freeWasmMemory(module, [...inputPointers, ...targetPointers]);

        // log
        console.log(`Processed waveforms for model index ${indexInModel}`);
        return processedWaveforms;
    } catch (error) {
        console.error('Error in processAudio:', error);

        console.error("Error processing audio");
        postMessage({
            msg: 'WASM_ERROR',
        });

        // don't return here but abort
        close();
    }
}

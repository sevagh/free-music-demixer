let wasmModule;
let loadedModule;

onmessage = function(e) {
    if (e.data.msg === 'LOAD_WASM') {
        loadWASMModule(e.data.scriptName);
    } else if (e.data.msg === 'PROCESS_AUDIO') {
        const inputData = new Float32Array(e.data.inputData); // Convert back from ArrayBuffer
        const length = e.data.length;  // Use the correct length

        const batchMode = e.data.batchMode;

        console.log('Running MIDI inference...');

        // Allocate memory in WASM and copy input data into the WASM memory
        const audioPointer = loadedModule._malloc(inputData.length * inputData.BYTES_PER_ELEMENT);
        const wasmInputArray = new Float32Array(loadedModule.HEAPF32.buffer, audioPointer, inputData.length);
        wasmInputArray.set(inputData);

        // Allocate memory for MIDI data pointer and size
        const midiDataPointer = loadedModule._malloc(4);  // Allocate 4 bytes for the pointer (uint8_t*)
        const midiSizePointer = loadedModule._malloc(4);  // Allocate 4 bytes for the size (int)

        const mxmlDataPointer = loadedModule._malloc(4);  // Allocate 4 bytes for the pointer (uint8_t*)
        const mxmlSizePointer = loadedModule._malloc(4);  // Allocate 4 bytes for the size (int)

        // Call the WASM function with the audio buffer, length, and pointers for the MIDI data and size
        // TODO: choose a better stem name
        loadedModule._convertToMidi(audioPointer, length, midiDataPointer, midiSizePointer, mxmlDataPointer, mxmlSizePointer, batchMode);

        // Retrieve the MIDI data pointer and size from WASM memory
        const midiData = loadedModule.getValue(midiDataPointer, 'i32');  // Get the pointer to MIDI data
        const midiSize = loadedModule.getValue(midiSizePointer, 'i32'); // Get the size of the MIDI data

        const mxmlData = loadedModule.getValue(mxmlDataPointer, 'i32');  // Get the pointer to MIDI data
        const mxmlSize = loadedModule.getValue(mxmlSizePointer, 'i32'); // Get the size of the MIDI data

        if (midiData === 0 && mxmlData === 0) {
            console.error('Failed to generate MIDI and musicxml data.');
            console.log('midiSize:', midiSize);
            console.log('mxmlSize:', mxmlSize);
            postMessage({ msg: 'PROCESSING_FAILED' });
            return;
        }

        // If valid MIDI data was returned
        // Access the MIDI data from WASM memory
        const midiBytes = new Uint8Array(loadedModule.HEAPU8.buffer, midiData, midiSize);
        const mxmlBytes = new Uint8Array(loadedModule.HEAPU8.buffer, mxmlData, mxmlSize);

        // Create a new ArrayBuffer and copy the MIDI data into it
        const transferableMidiBytes = new Uint8Array(midiSize);
        transferableMidiBytes.set(midiBytes);

        const transferableMxmlBytes = new Uint8Array(mxmlSize);
        transferableMxmlBytes.set(mxmlBytes);

        // Send the copied MIDI data back to the main thread with transferList
        postMessage({
            msg: 'PROCESSING_DONE',
            midiBytes: transferableMidiBytes.buffer, // Only pass the ArrayBuffer
            mxmlBytes: transferableMxmlBytes.buffer,
            stemName: e.data.stemName
        }, [transferableMidiBytes.buffer, transferableMxmlBytes.buffer]); // Transfer the buffer ownership

        // Free the memory allocated for the MIDI data in WASM
        loadedModule._free(midiData);
        loadedModule._free(mxmlData);

        // Free the memory allocated in WASM for the input audio and the MIDI pointer/size
        loadedModule._free(audioPointer);
        loadedModule._free(midiDataPointer);
        loadedModule._free(midiSizePointer);
        loadedModule._free(mxmlDataPointer);
        loadedModule._free(mxmlSizePointer);
    }
};

function loadWASMModule(scriptName) {
    importScripts(`${scriptName}?v=${new Date().getTime()}`);  // Load the WASM glue code w/ cache busting

    // Initialize the WASM module (which should set `Module`)
    wasmModule = libbasicpitch(); // Module is created in the glue code

    wasmModule.then((loaded_module) => {
        postMessage({ msg: 'WASM_READY' });
        loadedModule = loaded_module;
    });
}

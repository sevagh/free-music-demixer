import { encodeWavFileFromAudioBuffer } from './WavFileEncoder.js';
import {
    processSegments,
    sumSegments,
    fetchAndCacheFiles,
    computeModelAndStems,
    openSheetMusicInNewTab,
    MidiWorkerManager
} from './app-refactor.js';

const componentsCheckboxes = document.querySelectorAll('#modelPickerForm input[type="checkbox"]');
const qualityRadios = document.querySelectorAll('#qualityPickerForm input[type="radio"]');
const memoryRadios = document.querySelectorAll('#memorySelectorForm input[type="radio"]');
const MAX_FREE_JOBS = 3;
qualityRadios.forEach(radio => radio.addEventListener('change', updateModelBasedOnSelection));
let selectedModel;
let selectedStems;

componentsCheckboxes.forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
        const checkboxes = document.querySelectorAll('#modelPickerForm input[type="checkbox"]:not([disabled])');
        const checkedCount = Array.from(checkboxes).filter(cb => cb.checked).length;

        if (checkedCount === 0) {
            checkbox.checked = true;
        }

        updateModelBasedOnSelection();
    });
});

let processingMode = 'stems';

document.getElementById('processingPickerForm').addEventListener('change', (event) => {
    const isMidiOnly = document.getElementById('midi').checked;
    const isBoth = document.getElementById('both').checked;

    // if the user is logged in, activate tier UIs
    const loggedIn = sessionStorage.getItem('loggedIn') === 'true';
    let userTier = 0;
    if (loggedIn) {
        userTier = parseInt(sessionStorage.getItem('userTier'));
        if ((userTier === -1) || isNaN(userTier)) {
            userTier = 0;
        }
    }

    // if userTier is 0, keep default/medium/high quality radio buttons disabled
    if (userTier === 0) {
      ['vocals', 'drums', 'bass', 'melody', 'instrumental', 'piano', 'guitar', 'other_melody', 'default-quality'].forEach(element => {
          document.getElementById(element).disabled = isMidiOnly;
      });
    } else if (userTier === 2) {
      // iterate and disable all quality radio buttons
      qualityRadios.forEach(radio => radio.disabled = isMidiOnly);
      // also iterate and disable all component checkboxes
      componentsCheckboxes.forEach(checkbox => checkbox.disabled = isMidiOnly);
    }

    // also disable the "advancedSettingsToggle" and radios
    memoryRadios.forEach(radio => radio.disabled = isMidiOnly);

    // Hide and disable advanced settings toggle button
    const advancedSettings = document.getElementById('advancedSettings');

    if (isMidiOnly) {
      // Hide and disable the advanced settings dropdown
      advancedSettings.style.display = 'none'; // Ensure advanced settings are hidden
    }

    let inferenceStyle = '';
    let midiStyle = '';
    if (isMidiOnly) {
      processingMode = 'midi';
      inferenceStyle = 'none';
      midiStyle = 'block';
    } else if (isBoth) {
      processingMode = 'both';
      inferenceStyle = 'block';
      midiStyle = 'block';
    } else {
      processingMode = 'stems';
      inferenceStyle = 'block';
      midiStyle = 'none';
    }

    document.getElementById('inference-progress-bar').style.display = inferenceStyle;
    document.getElementById('inference-progress-text').style.display = inferenceStyle;
    document.getElementById('inference-progress-bar-outer').style.display = inferenceStyle;
    document.getElementById('midi-progress-bar').style.display = midiStyle;
    document.getElementById('midi-progress-text').style.display = midiStyle;
    document.getElementById('midi-progress-bar-outer').style.display = midiStyle;

    console.log("Setting processing mode to:", processingMode);
    updateModelBasedOnSelection();
});

let NUM_WORKERS = 4;
let workers;
let workerProgress;
let dlModelBuffers;
let jobRunning = false;

let WAV_BIT_DEPTH_SETTING = 0; // Default to 16-bit WAV

let processedSegments = new Array(NUM_WORKERS); // Global accumulator for processed segments
let completedSegments = 0; // Counter for processed segments
let completedSongsBatch = 0; // Counter for processed songs in batch mode
let batchNextFileResolveCallback = null; // Callback for resolving the next file in batch mode
let globalProgressIncrement = 0; // Global progress increment for batch mode

const DEMUCS_SAMPLE_RATE = 44100;
const DEMUCS_OVERLAP_S = 0.75;
const DEMUCS_OVERLAP_SAMPLES = Math.floor(DEMUCS_SAMPLE_RATE * DEMUCS_OVERLAP_S);

const tierNames = {0: 'Free', 2: 'Pro'};

const fileInput = document.getElementById('audio-upload');
const folderInput = document.getElementById('batch-upload');
const selectedInputMessage = document.getElementById('selectedInputMessage');
let isSingleMode = true;
let selectedInput = null;

const step1 = document.getElementById('wizard-step-1');
const step2 = document.getElementById('wizard-step-2');
const step3 = document.getElementById('wizard-step-3');
const step4SheetMusic = document.getElementById('wizard-step-4-sheet-music');

const nextStep1Btn = document.getElementById('next-step-1');
const nextStep2Btn = document.getElementById('next-step-2');
const nextStep3BtnSheetMusic = document.getElementById('next-step-3-sheet-music');
const nextStep3BtnNewJob = document.getElementById('next-step-3-new-job');
const nextStep4Btn = document.getElementById('next-step-4');

const prevStep1Btn = document.getElementById('prev-step-1');
const prevStep2Btn = document.getElementById('prev-step-2');
const prevStep3Btn = document.getElementById('prev-step-3');
const prevStep4Btn = document.getElementById('prev-step-4');

function getAudioContext(sampleRate) {
    return new (window.AudioContext || window.webkitAudioContext)({sampleRate: sampleRate});
}

const demucsAudioContext = getAudioContext(44100);
const basicpitchAudioContext = getAudioContext(22050);

const mobileWarning = document.getElementById('mobile-warning-container');
const mediaQuery = window.matchMedia('(max-width: 512px)');

function handleMediaQueryChange(e) {
  if (e.matches) {
    // user is on a small screen
    // verify that it is visible to track the event
    if (mobileWarning && getComputedStyle(mobileWarning).display !== 'none') {
      // Track the event
      trackProductEvent('mobile-warning-displayed');
    } else {
      // Track the event
      trackProductEvent('mobile-warning-failed-to-display');
    }

    // set the memory  to 4gb
    const memory4gb = document.getElementById('4gb');
    memory4gb.checked = true; // Default to 4 GB

    // Track the user’s action here
    trackProductEvent('mobile-lower-mem', {
        memorySetTo: '4gb'
    });

  }
}
mediaQuery.addEventListener('change', handleMediaQueryChange);

// also check on initial load:
if (mediaQuery.matches) {
    // reuse the function to track the event
    handleMediaQueryChange(mediaQuery);
}

document.addEventListener("DOMContentLoaded", function() {
    registerServiceWorker();
    resetUIElements();
});

const registerServiceWorker = async () => {
  if ("serviceWorker" in navigator) {
    try {
      const registration = await navigator.serviceWorker.register("/service-worker.js", {
        scope: "/",
      });
      if (registration.installing) {
        console.log("Service worker installing");
      } else if (registration.waiting) {
        console.log("Service worker installed");
      } else if (registration.active) {
        console.log("Service worker active");
      }
    } catch (error) {
      console.error(`Registration failed with ${error}`);
    }
  }
};

function resetUIElements() {
    // Disable PRO-tier MIDI feature
    document.getElementById('stems').checked = true;
    document.getElementById('midi-progress-bar').style.display = 'none';
    document.getElementById('midi-progress-text').style.display = 'none';
    document.getElementById('midi-progress-bar-outer').style.display = 'none';
    document.getElementById('inference-progress-text').style.display = 'block';
    document.getElementById('inference-progress-bar').style.display = 'block';
    document.getElementById('inference-progress-bar-outer').style.display = 'block';

    // enable all free-tier checkboxes
    // accounting for midi toggle disabling
    ['vocals', 'drums', 'bass', 'melody', 'instrumental', 'piano', 'guitar', 'other_melody', 'default-quality', '4gb', '8gb', '16gb', '32gb'].forEach(element => {
        document.getElementById(element).disabled = false;
    });

    // Disable PRO-tier checkboxes and add lock symbol
    document.getElementById('medium-quality').disabled = true;
    document.querySelector('label[for="medium-quality"]').textContent = 'Medium 🔒';

    document.getElementById('high-quality').disabled = true;
    document.querySelector('label[for="high-quality"]').textContent = 'High 🔒';

    // Reset checkboxes
    componentsCheckboxes.forEach(checkbox => checkbox.checked = false);
    ['vocals', 'drums', 'bass', 'melody', 'instrumental'].forEach(element => {
        document.getElementById(element).checked = true;
    });

    // Reset quality radio buttons
    qualityRadios.forEach(radio => radio.checked = false);
    document.getElementById('default-quality').checked = true;

    // set memory radio buttons to default
    const mobileWarning = document.getElementById('mobile-warning-container');
    const memory4gb = document.getElementById('4gb');
    const memory8gb = document.getElementById('8gb');

    // Check mobile warning visibility at load time to set appropriate default
    if (mobileWarning && getComputedStyle(mobileWarning).display !== 'none') {
        // Mobile warning scenario (small screen)
        memory4gb.checked = true; // Default to 4 GB
        console.log('Default memory set to 4 GB (small screen).');
    } else {
        // Regular scenario (larger screen)
        memory8gb.checked = true; // Default to 8 GB
        console.log('Default memory set to 8 GB (large screen).');
    }

    // set wav bit depth to default
    WAV_BIT_DEPTH_SETTING = 0; // Default to 16-bit WAV
    const bitDepth16 = document.getElementById('16bit');
    bitDepth16.checked = true; // Default to 16-bit

    // reset all disabled buttons to disabled
    prevStep1Btn.disabled = true;
    nextStep3BtnSheetMusic.disabled = true;
    nextStep3BtnNewJob.disabled = true;
    prevStep3Btn.disabled = true;

    initializeInputState();

    // if the user is logged in, activate tier UIs
    const loggedIn = sessionStorage.getItem('loggedIn') === 'true';
    let userTier = 0;
    if (loggedIn) {
        userTier = parseInt(sessionStorage.getItem('userTier'));
        if ((userTier === -1) || isNaN(userTier)) {
            userTier = 0;
        }
    }
    activateTierUI(userTier);
}

// Set up an event listener for the custom 'loginSuccess' event
window.addEventListener('loginSuccess', (event) => {
    console.log('Login success event detected in app.js');

    // Call resetUIElements to handle UI updates after login
    resetUIElements();
  });


// Attach the beforeunload event listener
window.addEventListener("beforeunload", (event) => {
    if (jobRunning) {
      // Show a warning dialog
      event.preventDefault();
      event.returnValue = ""; // Modern browsers display a default message
      return ""; // Necessary for older browsers
    }
  });

function updateModelBasedOnSelection() {
    console.log('Updating model based on selection');

    const selectedQuality = document.querySelector('input[type="radio"][name="quality"]:checked').value;

    const selectedFeatures = Array.from(componentsCheckboxes)
      .filter(checkbox => checkbox.checked)
      .map(checkbox => checkbox.value);

    const { model, stems } = computeModelAndStems(processingMode, selectedFeatures, selectedQuality);

    selectedModel = model;      // or some other variable
    selectedStems = stems;

    console.log(`New model: ${selectedModel}, stems: ${selectedStems.join(",")}`);
}

// Event listener for user interaction
document.addEventListener('click', function() {
    if (demucsAudioContext.state === 'suspended') {
        demucsAudioContext.resume();
    }
    if (basicpitchAudioContext.state === 'suspended') {
        basicpitchAudioContext.resume();
    }
});

function initWorkers() {
   // replace empty global workers with NUM_WORKERS new workers
   // if workers has already been initialized, loop over and terminate
   // old workers
   if (workers) {
        workers.forEach(worker => {
             worker.terminate();
        });
        workerProgress = null;
   }

   workers = new Array(NUM_WORKERS);
   workerProgress = new Array(NUM_WORKERS).fill(0);

   for (let i = 0; i < NUM_WORKERS; i++) {
        // push new worker onto workers array
        workers[i] = new Worker('stem-worker.js');

        workers[i].onmessage = function(e) {
            if (e.data.msg == 'WASM_READY') {
            } else if (e.data.msg === 'PROGRESS_UPDATE') {
                // Update the progress bar
                // adjust for total number of workers
                workerProgress[i] = e.data.data;
                // sum up all the progress for total progress
                const totalProgress = workerProgress.reduce((a, b) => a + b, 0) / NUM_WORKERS;
                document.getElementById('inference-progress-bar').style.width = `${totalProgress * 100}%`;
            } else if (e.data.msg === 'PROGRESS_UPDATE_BATCH') {
                workerProgress[i] = e.data.data;
                const averageProgressPerWorker = workerProgress.reduce((a, b) => a + b, 0) / NUM_WORKERS;
                const totalProgressForCurrentSong = averageProgressPerWorker * globalProgressIncrement; // Now in percentage
                const startingPointForCurrentSong = (completedSongsBatch * globalProgressIncrement);
                const newBatchWidth = startingPointForCurrentSong + totalProgressForCurrentSong;
                document.getElementById('inference-progress-bar').style.width = `${newBatchWidth}%`;
            } else if (e.data.msg === 'PROCESSING_DONE') {
                // Handle the processed segment
                // Collect and stitch segments
                processedSegments[i] = e.data.waveforms;
                let originalLength = e.data.originalLength;
                completedSegments +=1;
                workers[i].terminate();
                // if all segments are complete, stitch them together
                if (completedSegments === NUM_WORKERS) {
                    if (processingMode === 'stems') {
                        incrementUsage();
                    }
                    const retSummed = sumSegments(processedSegments, originalLength, DEMUCS_OVERLAP_SAMPLES);
                    trackProductEvent('demix-completed', {
                        model: selectedModel,
                        stems: selectedStems.join(','),
                        processingMode: getSelectedProcessingMode(),
                        features: getSelectedFeatures(),
                        quality: getSelectedQuality(),
                        memory: getSelectedMemory(),
                        mobileWarning: getMobileWarningShown(),
                        wavBitDepth: getSelectedWavBitDepth(),
                    });
                    packageAndDownload(retSummed);
                    // reset globals etc.
                    processedSegments = null; // this one will be recreated with appropriate num_workers next time
                    completedSegments = 0;
                    jobRunning = false;
                }
            } else if (e.data.msg === 'PROCESSING_DONE_BATCH') {
                // similar global bs here
                const filename = e.data.filename;
                processedSegments[i] = e.data.waveforms;
                completedSegments += 1;
                let originalLength = e.data.originalLength;
                if (completedSegments === NUM_WORKERS) {
                    console.log(`Completed all segments for ${filename}`);
                    if (processingMode === 'stems') {
                        incrementUsage();
                    }
                    const totalFiles = document.getElementById('batch-upload').files.length;

                    const retSummed = sumSegments(processedSegments, originalLength, DEMUCS_OVERLAP_SAMPLES);
                    trackProductEvent('batch-demix-completed', {model: selectedModel, stems: selectedStems.join(',')});
                    packageAndZip(retSummed, filename, totalFiles);
                    // reset globals per-song in the batch process
                    completedSegments = 0;

                    // full song is done
                    completedSongsBatch += 1;

                    // reset workerProgress
                    workerProgress = new Array(NUM_WORKERS).fill(0);

                    // promise resolve to move onto the next file
                    if (batchNextFileResolveCallback) {
                        batchNextFileResolveCallback(); // Resolve the Promise for the current file
                        batchNextFileResolveCallback = null; // Reset the callback
                    }

                    // if all songs are done, reset completedSongsBatch
                    if (completedSongsBatch === totalFiles) {
                        trackProductEvent('entire-batch-completed', {model: selectedModel, stems: selectedStems.join(',')});
                        completedSongsBatch = 0;

                        // terminate the workers
                        workers.forEach(worker => {
                            worker.terminate();
                        });
                        // reset batch globals
                        processedSegments = null;

                        // reset jobRunning flag
                        jobRunning = false;

                        // re-enable UI buttons only if pure-stems
                        // if in mixed mode (any kind of midi or _only_ midi), we should wait
                        if (processingMode === 'stems') {
                            prevStep3Btn.disabled = false;
                            nextStep3BtnNewJob.disabled = false;
                        }
                    }
                }
            } else if (e.data.msg === 'WASM_ERROR') {
                // Handle the error by modifying the UI to reflect the error state
                console.log('Error executing WASM');
                trackProductEvent('wasm-error', {model: selectedModel, stems: selectedStems.join(',')});
                // fill the inference progress bar with the color red
                document.getElementById('inference-progress-bar').style.backgroundColor = 'red';
                document.getElementById('inference-progress-bar').style.width = "100%";

                // in the outputs div, write in red text
                const outputLinksDiv = document.getElementById('output-links');

                const errorText = document.createElement('p');
                errorText.textContent = '❌ An error occured. Refresh the page and try again with more memory from "Advanced" settings';

                outputLinksDiv.appendChild(errorText);
            }
        };

        // Assuming 'selectedModel' is a global variable that is set to the model name prefix
        // such as 'demucs_free', 'demucs_karaoke', or 'demucs_pro'
        console.log(`Selected model: ${selectedModel}, with stems: ${selectedStems}`);

        // Post the blob URLs to the worker
        workers[i].postMessage({
            msg: 'LOAD_WASM',
            model: selectedModel,
            stems: selectedStems,
            modelBuffers: dlModelBuffers
        });
    }

    // set global jobRunning flag to true
    jobRunning = true;
};
async function initModel() {
    // Show step 3 immediately
    step3.style.display = 'block';
    step2.style.display = 'none';

    // reset the progress bar
    document.getElementById('inference-progress-bar').style.width = '0%';
    document.getElementById('midi-progress-bar').style.width = '0%';

    // delete the previous download links
    let downloadLinksDiv = document.getElementById('output-links');
    while (downloadLinksDiv.firstChild) {
        downloadLinksDiv.removeChild(downloadLinksDiv.firstChild);
    }

    if (processingMode === 'midi') {
        return;
    }

    // Create disabled placeholder links for each expected stem
    // add "all_stems.zip" before the placeholder links - also disabled
    // in single mode
    if (isSingleMode) {
        const allStemsLink = document.createElement('a');
        allStemsLink.href = '#';
        allStemsLink.className = 'download-link disabled';
        allStemsLink.style.color = '#999';
        allStemsLink.style.pointerEvents = 'none';
        allStemsLink.textContent = 'all_stems.zip';
        downloadLinksDiv.appendChild(allStemsLink);
        selectedStems.forEach(stem => {
            const placeholderLink = document.createElement('a');
            placeholderLink.href = '#';
            placeholderLink.className = 'download-link disabled';
            placeholderLink.style.color = '#999';
            placeholderLink.style.pointerEvents = 'none';
            placeholderLink.textContent = `${stem}.wav`;
            downloadLinksDiv.appendChild(placeholderLink);
        });
    } else {
        // in batch mode, generate placeholders for the zip associated to each song
        const files = folderInput.files;
        const totalFiles = files.length;
        for (let i = 0; i < totalFiles; i++) {
            const file = files[i];
            const filenameWithoutExt = file.name.slice(0, file.name.lastIndexOf('.'));

            const placeholderLink = document.createElement('a');
            placeholderLink.href = '#';
            placeholderLink.className = 'download-link disabled';
            placeholderLink.style.color = '#999';
            placeholderLink.style.pointerEvents = 'none';
            placeholderLink.textContent = `${filenameWithoutExt}_stems.zip`;
            downloadLinksDiv.appendChild(placeholderLink);
        }
    }

    // Show progress bar and start at 0
    document.getElementById('inference-progress-bar').style.width = '0%';

    try {
        // Fetch model files with progress updates
        const buffers = await fetchAndCacheFiles(
            selectedModel,
            selectedStems,
            (progress) => {
                // Update progress bar
                document.getElementById('inference-progress-bar').style.width = `${progress}%`;
                document.getElementById('inference-progress-text').textContent =
                    `Downloading AI weights... ${Math.round(progress)}%`;
            }
        );

        console.log('Model files fetched:', buffers);

        // Store buffers and update UI
        dlModelBuffers = buffers;
        nextStep3BtnNewJob.disabled = false;

        // Update message to show download completion
        console.log('Model files downloaded');

        // reset the progress bar and text to move onto stem processing
        document.getElementById('inference-progress-bar').style.width = '0%';
        document.getElementById('inference-progress-text').textContent = 'Stems progress...';
    } catch (error) {
        // Show error in UI
        prepMessage.innerHTML = '❌ Failed to download models. Please try again.';
        console.error('Failed to fetch model files:', error);
    }
}

function initializeInputState() {
    if (fileInput.files.length > 0) {
        isSingleMode = true;
        selectedInput = fileInput.files[0];
        updateSelectedInputMessage();
        clearErrorMessage('upload-error');
    } else if (folderInput.files.length > 0) {
        isSingleMode = false;
        selectedInput = folderInput.files;
        updateSelectedInputMessage();
        clearErrorMessage('upload-error');
    }
}

// Event listener for file input
fileInput.addEventListener('change', function() {
    if (fileInput.files.length > 0) {
        // If a file is selected, clear the folder input
        folderInput.value = '';
        isSingleMode = true;
        selectedInput = fileInput.files[0];
        updateSelectedInputMessage();

        // Start preloading the default model (4-source free)
        fetchAndCacheFiles('demucs-free-4s', ['vocals', 'drums', 'bass', 'melody']);
        clearErrorMessage('upload-error');
    }
});

// Event listener for folder input
folderInput.addEventListener('change', function() {
    if (folderInput.files.length > 0) {
        // If a folder is selected, clear the file input
        fileInput.value = '';
        isSingleMode = false;
        selectedInput = folderInput.files;
        updateSelectedInputMessage();

        // Start preloading the default model (4-source free)
        fetchAndCacheFiles('demucs-free-4s', ['vocals', 'drums', 'bass', 'melody']);
        clearErrorMessage('upload-error');
    }
});

// Function to update the selected input message
function updateSelectedInputMessage() {
    if (isSingleMode && selectedInput) {
        selectedInputMessage.textContent = `Selected input: ${selectedInput.name}`;
    } else if (!isSingleMode && selectedInput) {
        selectedInputMessage.textContent = `Selected input: folder with ${selectedInput.length} files`;
    } else {
        selectedInputMessage.textContent = 'Selected input:';
    }
}

function initAndResetWeeklyUsage() {
    let usageData = JSON.parse(localStorage.getItem('weeklyUsage'));
    if (!usageData) {
      usageData = {
        count: 0,
        weekStart: new Date().toISOString(),
      };
      localStorage.setItem('weeklyUsage', JSON.stringify(usageData));
    }

    const weekStart = new Date(usageData.weekStart);
    const now = new Date();

    // If more than a week has passed, reset usage
    if ((now - weekStart) > 7 * 24 * 60 * 60 * 1000) {
      usageData.count = 0;
      usageData.weekStart = now.toISOString();
      localStorage.setItem('weeklyUsage', JSON.stringify(usageData));
    }

    return usageData;
}

function activateTierUI(userTier) {
  console.log('Enabling UI for user tier:', userTier); // Debugging
  // Enable buttons based on user tier

  if (userTier === 2) {
    // Enable PRO-tier MIDI feature
    document.getElementById('midi').disabled = false;
    document.getElementById('both').disabled = false;
    document.querySelector('label[for="both"]').textContent = 'Stems + MIDI music transcription';
    document.querySelector('label[for="midi"]').textContent = 'MIDI music transcription only';

    // Enable PRO-tier radio buttons (medium, high quality)
    document.getElementById('medium-quality').disabled = false;
    document.getElementById('high-quality').disabled = false;

    // Remove lock symbol (🔒) from the labels
    document.querySelector('label[for="medium-quality"]').textContent = 'Medium';
    document.querySelector('label[for="high-quality"]').textContent = 'High';


    console.log('PRO-tier UI elements enabled.');

    // clear the usage limits error message
    clearErrorMessage('runjob-error');
  }

  initAndResetWeeklyUsage();
}

const toggleButton = document.getElementById('advancedSettingsToggle');
const tooltipToggleButton = document.getElementById('midiTooltipToggle');
const advancedSettings = document.getElementById('advancedSettings');
const tooltipContents = document.getElementById('midiTooltip');
const qualitytooltipToggleButton = document.getElementById('qualityTooltipToggle');
const qualityTooltipContents = document.getElementById('qualityTooltip');
const componenttooltipToggleButton = document.getElementById('componentTooltipToggle');
const componentTooltipContents = document.getElementById('componentTooltip');

componenttooltipToggleButton.addEventListener('click', function() {
    if (componentTooltipContents.style.display === 'none') {
        componentTooltipContents.style.display = 'block';
    } else {
        componentTooltipContents.style.display = 'none';
    }
});

toggleButton.addEventListener('click', function() {
    const nowVisible = advancedSettings.style.display === 'none';
    advancedSettings.style.display = nowVisible ? 'block' : 'none';

    trackProductEvent('Toggled Advanced Settings', { nowVisible });
});

tooltipToggleButton.addEventListener('click', function() {
    const nowVisible = tooltipContents.style.display === 'none';
    tooltipContents.style.display = nowVisible ? 'block' : 'none';
    trackProductEvent('Toggled MIDI Tooltip', { nowVisible });
});

qualitytooltipToggleButton.addEventListener('click', function() {
    const nowVisible = qualityTooltipContents.style.display === 'none';
    qualityTooltipContents.style.display = nowVisible ? 'block' : 'none';
    trackProductEvent('Toggled Quality Tooltip', { nowVisible });
});

function getSelectedProcessingMode() {
  return document.querySelector('input[name="processingMode"]:checked')?.value || 'unknown';
}

function getSelectedFeatures() {
  const checked = [...document.querySelectorAll('#modelPickerForm input[name="feature"]:checked')];
  return checked.map(input => input.value);
}

function getSelectedQuality() {
  return document.querySelector('input[name="quality"]:checked')?.value || 'default';
}

function getSelectedMemory() {
  // adapt this function to return a 4gb default for smaller screens
  // and 8gb for larger screens
  const mobileWarning = document.getElementById('mobile-warning-container');

  // Check mobile warning visibility at load time to set appropriate default
  let defaultMem = '8gb'; // Default to 8GB for larger screens
  if (mobileWarning && getComputedStyle(mobileWarning).display !== 'none') {
      defaultMem = '4gb'; // Use 4GB for smaller screens
  }
  return document.querySelector('input[name="memory"]:checked')?.value || defaultMem;
}

function getSelectedFileCount() {
  const singleCount = document.getElementById('audio-upload').files.length;
  const batchCount = document.getElementById('batch-upload').files.length;
  return singleCount || batchCount; // whichever is not 0
}

function getSelectedWavBitDepth() {
    const bitDepth32 = document.getElementById('32bit');
    return bitDepth32.checked ? '32bit' : '16bit';
}

function getMobileWarningShown() {
    const mobileWarning = document.getElementById('mobile-warning-container');
    const mobileWarningShown = mobileWarning && getComputedStyle(mobileWarning).display !== 'none';
    return mobileWarningShown ? 'shown' : 'not shown'
}

nextStep1Btn.addEventListener('click', function() {
    // 1) Check if a file/folder was selected
    if (!selectedInput) {
        // e.g., show an inline error:
        showErrorMessage("Please select an audio file or folder first.", "upload-error", nextStep1Btn);
        return;
    }

    trackProductEvent('Uploaded File (wizard step 1)', {
        batchMode: !isSingleMode,
    });

    // simply toggle the visibility of the step 1 and step 2 divs
    step1.style.display = 'none';
    step2.style.display = 'block';
});

function showErrorMessage(msg, elementId, buttonToShake) {
    const errorElem = document.getElementById(elementId);
    errorElem.style.display = 'block';
    errorElem.innerHTML = msg;

    // Shake the Next button:
    buttonToShake.classList.remove('shake');
    // Force a reflow so the class can be re-applied for consecutive shakes
    void buttonToShake.offsetWidth;
    buttonToShake.classList.add('shake');

    // Optional: remove the shake class automatically after animation
    setTimeout(() => {
      buttonToShake.classList.remove('shake');
    }, 400); // match the 0.4s animation time

    // force scroll to the error message
    errorElem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // set focus on the error message
    errorElem.focus();
    // set focus on the button
    buttonToShake.focus();
}

function clearErrorMessage(elementId) {
    const errorElem = document.getElementById(elementId);
    errorElem.style.display = 'none';
}

nextStep2Btn.addEventListener('click', function(e) {
    clearErrorMessage('upload-error');

    // 1) Make sure usageData is initialized & possibly reset for a new week
    const usageData = initAndResetWeeklyUsage();

    const remaining = MAX_FREE_JOBS - usageData.count;
    const loggedIn = sessionStorage.getItem('loggedIn') === 'true';

    clearErrorMessage('runjob-error');

    updateModelBasedOnSelection();

    trackProductEvent('Chose Model (wizard step 2)', {
        model: selectedModel,
        processingMode: getSelectedProcessingMode(), // see below
        features: getSelectedFeatures(),
        quality: getSelectedQuality(),
        memory: getSelectedMemory(),
        mobileWarning: getMobileWarningShown(),
        wavBitDepth: getSelectedWavBitDepth(),
    });

    console.log('Selected input on next step:', selectedInput, 'isSingleMode:', isSingleMode);

    // Check if mobile warning container exists and is currently hidden
    const mobileWarning = document.getElementById('mobile-warning-container');
    const mobileWarningShown = mobileWarning && getComputedStyle(mobileWarning).display !== 'none';

    if (mobileWarningShown) {
        // Mobile warning is visible, meaning we are in mobile-warning scenario
        const proceed = confirm("⚠️ You're on a 📱 small screen. Running the demixer might be slow or crash. Are you sure you want to continue?");
        if (!proceed) {
            // User decided not to proceed, prevent further actions
            e.preventDefault();
            console.log("User cancelled due to mobile warning.");
            return;
        }
    } else {
        // Mobile warning is not visible, meaning we are not in mobile-warning scenario
        console.log("No mobile warning shown.");
    }

    // clear mxml sheet music buffers here, at start of new job - this is  THE place we want to do it
    // since we are fine discarding old results and there's no more navigating back to the previous step
    midiManager.mxmlBuffersSheetMusic = {};

    initModel().then(() => {
        console.log("Starting demix job");

        prevStep3Btn.disabled = true;
        nextStep3BtnSheetMusic.disabled = true;
        nextStep3BtnNewJob.disabled = true;

        // Parse the selected memory option from the radio buttons
        const selectedMemory = document.querySelector('input[name="memory"]:checked').value;
        const numWorkers = parseInt(selectedMemory) / 4;

        // Set the global NUM_WORKERS variable directly
        NUM_WORKERS = numWorkers;

        // Set global WAV_BIT_DEPTH to toggle between 16 and 32 bit WAV
        const selectedBitDepth = document.querySelector('input[name="bit-depth"]:checked').value;
        const wavBitDepthSetting = selectedBitDepth === '16bit' ? 0 : 1; // this is the argument to the wav file encoder function
        console.log("WAV Bit Depth Setting:", wavBitDepthSetting, "for bit depth:", selectedBitDepth);
        // Set global WAV_BIT_DEPTH_SETTING
        WAV_BIT_DEPTH_SETTING = wavBitDepthSetting;

        // we only enable the next/back buttons after the job returns

        // track the start of the job
        //trackProductEvent('Start Job', { mode: 'single', numWorkers: numWorkers });
        trackProductEvent('Start Job', {
            mode: isSingleMode ? 'single' : 'batch',
            numWorkers,
            processingMode,  // stems, midi, or both
            features: getSelectedFeatures(),
            quality: getSelectedQuality(),
            memory: getSelectedMemory(),
            fileCount: getSelectedFileCount(),
            wavBitDepth: selectedBitDepth,
        });

        // reset some globals e.g. progress
        processedSegments = new Array(NUM_WORKERS).fill(undefined);

        if (isSingleMode) {

            // write log of how many workers are being used
            if (processingMode != 'midi') {
                // else we are in midi mode and don't need to init workers
                initWorkers();
            }

            const reader = new FileReader();

            reader.onload = function(event) {

                const arrayBuffer = event.target.result;

                if (processingMode != 'midi') {
                    demucsAudioContext.decodeAudioData(arrayBuffer, function(decodedData) {
                        let leftChannel, rightChannel;
                        // decodedData is an AudioBuffer
                        if (decodedData.numberOfChannels == 1) {
                            // Mono case
                            leftChannel = decodedData.getChannelData(0); // Float32Array representing left channel data
                            rightChannel = decodedData.getChannelData(0); // Float32Array representing right channel data
                        } else {
                            // Stereo case
                            leftChannel = decodedData.getChannelData(0); // Float32Array representing left channel data
                            rightChannel = decodedData.getChannelData(1); // Float32Array representing right channel data
                        }

                        // set original length of track
                        let originalLength = leftChannel.length;

                        processSegments(workers, leftChannel, rightChannel, NUM_WORKERS, originalLength, DEMUCS_OVERLAP_SAMPLES);
                    });
                } else {
                    console.log("Converting input file to MIDI directly");
                    packageAndDownloadMidiOnly(arrayBuffer);
                }
            };

            reader.readAsArrayBuffer(fileInput.files[0]);
        } else {
            var downloadLinksDiv = document.getElementById('output-links');
            downloadLinksDiv.innerHTML = ''; // Clear existing links

            const files = folderInput.files;

            // write log of how many workers are being used
            if (processingMode != 'midi') {
                // else we are in midi mode and don't need to init workers
                initWorkers();
            }

            processFiles(files, processingMode === 'midi');
        }
    }).catch((error) => {
        console.error("Model initialization failed:", error);
    });
});

prevStep1Btn.addEventListener('click', function() {
    trackProductEvent('Wizard Step 2 → 1');

    // from step 3, undisable next/prev buttons
    prevStep3Btn.disabled = false;
    nextStep3BtnNewJob.disabled = false;

    if (processingMode != 'stems') {
        nextStep3BtnSheetMusic.disabled = false;
    }

    step1.style.display = 'none';
    step3.style.display = 'block';
});

prevStep2Btn.addEventListener('click', function() {
    trackProductEvent('Wizard Step 3 → 2');

    step2.style.display = 'none';
    step1.style.display = 'block';
});

prevStep3Btn.addEventListener('click', function() {
    trackProductEvent('Wizard Step 4 → 3');

    step3.style.display = 'none';
    step2.style.display = 'block';
});

const instrumentLinksContainer = document.getElementById("instrument-links");

nextStep3BtnSheetMusic.addEventListener('click', function() {
    trackProductEvent('Viewed Sheet Music Section');
    // OSMD display of mxmlBuffers

    step4SheetMusic.style.display = 'block';
    step3.style.display = 'none';

    // (Re)Generate the instrument links (or do this once if you prefer)
    instrumentLinksContainer.innerHTML = "";
    Object.keys(midiManager.mxmlBuffersSheetMusic).forEach((instrumentName) => {
      const link = document.createElement("a");
      link.href = "#";
      link.textContent = `Open new sheet music tab for: ${instrumentName}`;
      link.addEventListener("click", (e) => {
        e.preventDefault();
        trackProductEvent('Opened Sheet Music', { instrumentName });
        openSheetMusicInNewTab(midiManager.mxmlBuffersSheetMusic[instrumentName], instrumentName);
      });
      instrumentLinksContainer.appendChild(link);
      instrumentLinksContainer.appendChild(document.createElement("br"));
    });
  });

prevStep4Btn.addEventListener('click', function() {
    trackProductEvent('Wizard Step 5 → 4');

    step4SheetMusic.style.display = 'none';
    step3.style.display = 'block';
});

nextStep3BtnNewJob.addEventListener('click', function() {
    midiManager.completedSongsBatchMidi = 0;
    midiManager.queueTotal = 0;
    midiManager.queueCompleted = 0;

    trackProductEvent('New job button');

    // restart the wizard from step 1
    step3.style.display = 'none';
    step1.style.display = 'block';
});

nextStep4Btn.addEventListener('click', function() {
    trackProductEvent('Finished sheet music button');

    // restart the wizard from step 1
    step4SheetMusic.style.display = 'none';
    step1.style.display = 'block';
});

// Now create the manager
const midiManager = new MidiWorkerManager({
    workerScript: 'midi-worker.js',
    wasmScript: 'basicpitch_mxml.js',
    basicpitchAudioContext,
    trackProductEvent,
    encodeWavFileFromAudioBuffer
});

const midiStemNames = ['vocals', 'bass', 'melody', 'other_melody', 'piano', 'guitar'];

function generateBuffers(targetWaveforms, selectedStems, selectedModel, processingMode, midiStemNames, batchCount) {
    let stemNames = selectedStems.filter(stem => stem !== 'instrumental');

    // If model is free-6s or pro-cust, exclude melody from stems
    if (selectedModel === 'demucs-free-6s' || selectedModel === 'demucs-pro-cust' || selectedModel === 'demucs-pro-cust-spec') {
        stemNames = stemNames.filter(stem => stem !== 'melody');
    }

    const buffers = {};

    // Create buffers for each stem
    stemNames.forEach((name, index) => {
        const buffer = demucsAudioContext.createBuffer(2, targetWaveforms[0].length, DEMUCS_SAMPLE_RATE);
        buffer.copyToChannel(targetWaveforms[index * 2], 0); // Left channel
        buffer.copyToChannel(targetWaveforms[index * 2 + 1], 1); // Right channel
        buffers[name] = buffer;

        // Queue MIDI generation if required
        if (processingMode !== 'stems' && midiStemNames.includes(name)) {
            midiManager.queueMidiRequest(buffer, name, batchCount);
        }
    });

    // Add instrumental if requested
    if (selectedStems.includes('instrumental')) {
        if (selectedModel === 'demucs-karaoke') {
            // For demucs-karaoke, instrumental is simply the second returned stem
            const instrumentalBuffer = demucsAudioContext.createBuffer(2, targetWaveforms[0].length, DEMUCS_SAMPLE_RATE);
            instrumentalBuffer.copyToChannel(targetWaveforms[2], 0);
            instrumentalBuffer.copyToChannel(targetWaveforms[3], 1);
            buffers['instrumental'] = instrumentalBuffer;
        } else {
            // For other models, sum up all non-vocal stems (except certain stems in pro-cust)
            const instrumentalBuffer = demucsAudioContext.createBuffer(2, targetWaveforms[0].length, DEMUCS_SAMPLE_RATE);
            const instrumentalStems = stemNames.filter(name => name !== 'vocals');
            instrumentalStems.forEach(stemName => {
                // In pro-cust, skip adding guitar/piano/other_melody to instrumental
                // if you want to replicate that logic here, conditionally check selectedModel and stemName.
                const skipForProCust = selectedModel === 'demucs-pro-cust' &&
                                       ['guitar', 'piano', 'other_melody'].includes(stemName);
                if (!skipForProCust) {
                    const stemBuffer = buffers[stemName];
                    for (let i = 0; i < targetWaveforms[0].length; i++) {
                        instrumentalBuffer.getChannelData(0)[i] += stemBuffer.getChannelData(0)[i] || 0;
                        instrumentalBuffer.getChannelData(1)[i] += stemBuffer.getChannelData(1)[i] || 0;
                    }
                }
            });
            buffers['instrumental'] = instrumentalBuffer;
        }
    }

    // Add melody for certain models by summing other_melody, piano, guitar
    if (selectedStems.includes('melody') && (selectedModel === 'demucs-free-6s' || selectedModel === 'demucs-pro-cust' || selectedModel === 'demucs-pro-cust-spec')) {
        const melodyBuffer = demucsAudioContext.createBuffer(2, targetWaveforms[0].length, DEMUCS_SAMPLE_RATE);
        const melodyStems = stemNames.filter(name => ['other_melody', 'piano', 'guitar'].includes(name));
        melodyStems.forEach(name => {
            const stemBuffer = buffers[name];
            for (let i = 0; i < targetWaveforms[0].length; i++) {
                melodyBuffer.getChannelData(0)[i] += stemBuffer.getChannelData(0)[i] || 0;
                melodyBuffer.getChannelData(1)[i] += stemBuffer.getChannelData(1)[i] || 0;
            }
        });
        buffers['melody'] = melodyBuffer;
    }

    return buffers;
}

function packageAndDownload(targetWaveforms) {
    // create the worker if needed
    if (processingMode != 'stems' && !midiManager.midiWorker) {
        midiManager.initializeMidiWorker();
    }

    // Generate all buffers and stems using the helper function
    // batch count is 1, this is a single file
    const buffers = generateBuffers(targetWaveforms, selectedStems, selectedModel, processingMode, midiStemNames, 1);

    // Wait for MIDI files to finish, then create download links
    midiManager.waitForMidiProcessing().then(() => {
        createDownloadLinks(buffers, false);
    });
}

function packageAndDownloadMidiOnly(inputArrayBuffer) {
    console.log(`Processing audio data in MIDI-only mode`);
    // create the worker
    if (processingMode != 'stems' && !midiManager.midiWorker) {
        midiManager.initializeMidiWorker();
    }

    // use the stem name 'output' for the midi-only output
    // directly operating on the user input
    // batch count = 1 because this is strictly a single-file case
    midiManager.queueMidiRequest(inputArrayBuffer, "output", 1, true);

    // Wait for all MIDI files to complete processing, then create download links
    midiManager.waitForMidiProcessing().then(() => {
        createDownloadLinks(null, true);
    });
}

function createDownloadLinks(buffers, midiOnlyMode) {
    var downloadLinksDiv = document.getElementById('output-links');
    downloadLinksDiv.innerHTML = ''; // Clear existing links

    var zipFiles = {};
    var tasks = [];

    if (!midiOnlyMode) {
        // WAV + MIDI mode
        Object.keys(buffers).forEach(function(stemName) {
            // Create WAV file data
            var wavData = encodeWavFileFromAudioBuffer(buffers[stemName], WAV_BIT_DEPTH_SETTING);
            zipFiles[stemName + ".wav"] = new Uint8Array(wavData);

            // WAV download link
            var wavBlob = new Blob([wavData], { type: 'audio/wav' });
            var wavUrl = URL.createObjectURL(wavBlob);
            var wavLink = document.createElement('a');
            wavLink.href = wavUrl;
            wavLink.textContent = stemName + ".wav";
            wavLink.download = stemName + ".wav";
            downloadLinksDiv.appendChild(wavLink);

            // If MIDI data exists for this stem, we queue it up
            if (midiManager.midiBuffers[stemName]) {
                tasks.push(midiManager.midiBuffers[stemName].arrayBuffer().then(arrBuf => {
                    zipFiles[stemName + ".mid"] = new Uint8Array(arrBuf);

                    const midiUrl = URL.createObjectURL(midiManager.midiBuffers[stemName]);
                    var midiLink = document.createElement('a');
                    midiLink.href = midiUrl;
                    midiLink.textContent = stemName + ".mid";
                    midiLink.download = stemName + ".mid";
                    downloadLinksDiv.appendChild(midiLink);
                }));
            }
        });
    } else {
        // MIDI-only mode
        Object.keys(midiManager.midiBuffers).forEach(stemName => {
            tasks.push(midiManager.midiBuffers[stemName].arrayBuffer().then(arrBuf => {
                zipFiles[stemName + ".mid"] = new Uint8Array(arrBuf);

                const midiUrl = URL.createObjectURL(midiManager.midiBuffers[stemName]);
                var midiLink = document.createElement('a');
                midiLink.href = midiUrl;
                midiLink.textContent = stemName + ".mid";
                midiLink.download = stemName + ".mid";
                downloadLinksDiv.appendChild(midiLink);
            }));
        });
    }

    // Once all MIDI tasks are done, create the ZIP at the top
    Promise.all(tasks).then(function() {
        if (Object.keys(zipFiles).length > 0) {
            var zipData = fflate.zipSync(zipFiles, { level: 0 }); // no compression for speed
            var zipBlob = new Blob([zipData.buffer], { type: 'application/zip' });
            var zipUrl = URL.createObjectURL(zipBlob);
            var zipLink = document.createElement('a');
            zipLink.href = zipUrl;
            zipLink.textContent = "all_stems.zip";
            zipLink.download = "all_stems.zip";

            // Style the zip link to stand out
            zipLink.classList.add("supreme-zip-link");

            // Insert the ZIP link at the top of the list
            if (downloadLinksDiv.firstChild) {
                downloadLinksDiv.insertBefore(zipLink, downloadLinksDiv.firstChild);
            } else {
                // If no other links present, just append
                downloadLinksDiv.appendChild(zipLink);
            }
        }

        // Clear MIDI buffers after links are created
        midiManager.midiBuffers = {};
        midiManager.mxmlBuffersSheetMusic = midiManager.mxmlBuffers;
        midiManager.mxmlBuffers = {};
        midiManager.queueTotal = 0;
        midiManager.queueCompleted = 0;

        // If in a mode that includes MIDI, increment usage
        if (processingMode != 'stems') {
            incrementUsage(); // Increment the weekly usage counter

            // Enable the sheet music button for MIDI modes
            // this is non-batch mode
            nextStep3BtnSheetMusic.disabled = false;
        }

        prevStep3Btn.disabled = false;
        nextStep3BtnNewJob.disabled = false;
    });
}

async function processFiles(files, midiOnlyMode) {
    console.log(`Processing ${files.length} files; midi-only mode?: ${midiOnlyMode}`);
    if (!files || files.length === 0) return;

    globalProgressIncrement = 100 / files.length; // Progress increment per file

    if (midiOnlyMode && !midiManager.midiWorker) {
        midiManager.initializeMidiWorker();
    }

    for (const file of files) {
        const reader = new FileReader();

        await new Promise(resolve => {
            reader.onload = async function(event) {
                const arrayBuffer = event.target.result;
                const filenameWithoutExt = file.name.slice(0, file.name.lastIndexOf('.'));

                if (midiOnlyMode) {
                    // Directly queue for MIDI processing in MIDI-only mode
                    // batch count = files.length
                    midiManager.queueMidiRequest(arrayBuffer, filenameWithoutExt, files.length, true);

                    // Update the progress bar for each MIDI file
                    midiManager.waitForMidiProcessing().then(() => {
                        // Resolve the current file’s processing
                        midiManager.completedSongsBatchMidi += 1;
                        resolve();
                    });
                } else {
                    // For non-MIDI-only mode, decode and process with stem separation
                    demucsAudioContext.decodeAudioData(arrayBuffer, decodedData => {
                        let leftChannel, rightChannel;
                        if (decodedData.numberOfChannels === 1) {
                            leftChannel = decodedData.getChannelData(0);
                            rightChannel = decodedData.getChannelData(0);
                        } else {
                            leftChannel = decodedData.getChannelData(0);
                            rightChannel = decodedData.getChannelData(1);
                        }

                        let originalLength = leftChannel.length;
                        processSegments(workers, leftChannel, rightChannel, NUM_WORKERS, originalLength, DEMUCS_OVERLAP_SAMPLES, filenameWithoutExt);
                        batchNextFileResolveCallback = resolve;
                    });
                }
            };

            reader.readAsArrayBuffer(file);
        });
    }

    // Handle pure-midi here: mixed stems + midi is handled in different functions, keep reading below
    if (processingMode === 'midi') {
        console.log("All MIDI files processed.");

        // Iterate over each completed MIDI file in midiBuffers and append links
        for (const filename in midiManager.midiBuffers) {
            const midiBlob = midiManager.midiBuffers[filename];
            if (midiBlob) {
                const midiUrl = URL.createObjectURL(midiBlob);
                const link = document.createElement('a');
                link.href = midiUrl;
                link.textContent = `${filename}.mid`;
                link.download = `${filename}.mid`;

                document.getElementById('output-links').appendChild(link);
            }
        }

        // Clear midiBuffers after links are created
        midiManager.midiBuffers = {};

        // create sheet music buffers
        Object.keys(midiManager.mxmlBuffers).forEach(key => {
            midiManager.mxmlBuffersSheetMusic[`${key}`] = midiManager.mxmlBuffers[key];
        });
        // Now clear mxmlBuffers
        midiManager.mxmlBuffers = {};
        midiManager.queueTotal = 0;
        midiManager.queueCompleted = 0;

        prevStep3Btn.disabled = false;
        nextStep3BtnSheetMusic.disabled = false;
        nextStep3BtnNewJob.disabled = false;
    }

    // in the case of processingMode === 'both', that's handled in packageAndDownload or packageAndZip

    // for all modes that have midi, increment usage here
    if (processingMode != 'stems') {
        incrementUsage(); // Increment the weekly usage counter
    }
}

function packageAndZip(targetWaveforms, filename, batchCount) {
    // create the worker if needed
    if (processingMode != 'stems' && !midiManager.midiWorker) {
        midiManager.initializeMidiWorker();
    }

    // Generate buffers for all stems, including instrumental/melody logic
    const buffers = generateBuffers(targetWaveforms, selectedStems, selectedModel, processingMode, midiStemNames, batchCount);

    // Now we don't need to redo logic. Just zip all stems and MIDI files.
    const directoryName = `${filename}_stems/`;
    let zipFiles = {};

    // Encode WAV data from buffers and add them to zip
    Object.keys(buffers).forEach(stemName => {
        const wavData = encodeWavFileFromAudioBuffer(buffers[stemName], WAV_BIT_DEPTH_SETTING);
        zipFiles[`${directoryName}${stemName}.wav`] = new Uint8Array(wavData);
    });

    // Wait for MIDI
    midiManager.waitForMidiProcessing().then(() => {
        // Add MIDI files to zipFiles once processing is complete
        return Promise.all(
            Object.keys(midiManager.midiBuffers).map(stemName =>
                midiManager.midiBuffers[stemName].arrayBuffer().then(arrayBuffer => {
                    zipFiles[`${directoryName}${stemName}.mid`] = new Uint8Array(arrayBuffer);
                })
            )
        );
    }).then(() => {
        // Once all files are in zipFiles, create the zip and append download link
        const zipData = fflate.zipSync(zipFiles, { level: 0 }); // Disable compression for speed
        const zipBlob = new Blob([zipData.buffer], { type: 'application/zip' });

        // Create a download link for the zip file
        const zipUrl = URL.createObjectURL(zipBlob);
        const zipLink = document.createElement('a');
        zipLink.href = zipUrl;
        zipLink.textContent = `${filename}_stems.zip`;
        zipLink.download = `${filename}_stems.zip`;
        document.getElementById('output-links').appendChild(zipLink);

        // Clear midiBuffers after zip creation
        midiManager.midiBuffers = {};

        // copy mxmlBuffers before clearing, but prepend filename since this is a batch
        // and we need to distinguish between songs
         Object.keys(midiManager.mxmlBuffers).forEach(key => {
            midiManager.mxmlBuffersSheetMusic[`${filename}_${key}`] = midiManager.mxmlBuffers[key];
        });
        // Now clear mxmlBuffers
        midiManager.mxmlBuffers = {};
        midiManager.queueTotal = 0;
        midiManager.queueCompleted = 0;

        if (midiManager.completedSongsBatchMidi < document.getElementById('batch-upload').files.length - 1) {
            midiManager.completedSongsBatchMidi += 1;
        } else {
            midiManager.completedSongsBatchMidi = 0;
            // Enable the next buttons
            prevStep3Btn.disabled = false;

            // Enable the sheet music button for MIDI modes
            // this is batch mode
            if (processingMode != 'stems') {
                nextStep3BtnSheetMusic.disabled = false;
            }
            nextStep3BtnNewJob.disabled = false;
        }
    });
}

function incrementUsage() {
    // now undisable prevStep1Btn, which can lead to the last results
    prevStep1Btn.disabled = false;

    const loggedIn = sessionStorage.getItem('loggedIn') === 'true';
    if (loggedIn) {
        // dont increment for logged in users
        return;
    }
    const usageData = JSON.parse(localStorage.getItem('weeklyUsage'));
    usageData.count += 1;
    localStorage.setItem('weeklyUsage', JSON.stringify(usageData));

    initAndResetWeeklyUsage();
}

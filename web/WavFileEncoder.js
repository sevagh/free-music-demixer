export function encodeWavFileFromAudioBuffer(audioBuffer, wavFileType) {
    var numberOfChannels = audioBuffer.numberOfChannels;
    var numberOfFrames = audioBuffer.length;
    var sampleRate = audioBuffer.sampleRate;
    var channelData = Array(numberOfChannels);
    for (var channelNo = 0; channelNo < numberOfChannels; channelNo++) {
        channelData[channelNo] = audioBuffer.getChannelData(channelNo);
        if (channelData[channelNo].length != numberOfFrames) {
            throw new Error("Unexpected channel data array size.");
        }
    }
    return encodeWavFileFromArrays(channelData, sampleRate, wavFileType);
}
export function encodeWavFileFromArrays(channelData, sampleRate, wavFileType) {
    var numberOfChannels = channelData.length;
    if (numberOfChannels < 1) {
        throw new Error("No audio channels.");
    }
    var numberOfFrames = channelData[0].length;
    var bitsPerSample;
    var formatCode;
    var fmtChunkSize;
    var writeSampleData;
    switch (wavFileType) {
        case 0 /* WavFileType.int16 */: {
            bitsPerSample = 16;
            formatCode = 1; // WAVE_FORMAT_PCM
            fmtChunkSize = 16;
            writeSampleData = writeSampleData_int16;
            break;
        }
        case 1 /* WavFileType.float32 */: {
            bitsPerSample = 32;
            formatCode = 3; // WAVE_FORMAT_IEEE_FLOAT
            fmtChunkSize = 18; // 2 bytes more to include cbSize field (extension size)
            writeSampleData = writeSampleData_float32;
            break;
        }
        default: {
            throw new Error();
        }
    }
    var bytesPerSample = Math.ceil(bitsPerSample / 8);
    var bytesPerFrame = numberOfChannels * bytesPerSample;
    var bytesPerSec = sampleRate * numberOfChannels * bytesPerSample;
    var headerLength = 20 + fmtChunkSize + 8;
    var sampleDataLength = numberOfChannels * numberOfFrames * bytesPerSample;
    var fileLength = headerLength + sampleDataLength;
    var arrayBuffer = new ArrayBuffer(fileLength);
    var dataView = new DataView(arrayBuffer);
    writeWavFileHeader();
    writeSampleData();
    return arrayBuffer;
    function writeWavFileHeader() {
        setString(0, "RIFF"); // chunk ID
        dataView.setUint32(4, fileLength - 8, true); // chunk size
        setString(8, "WAVE"); // WAVEID
        setString(12, "fmt "); // chunk ID
        dataView.setUint32(16, fmtChunkSize, true); // chunk size
        dataView.setUint16(20, formatCode, true); // wFormatTag
        dataView.setUint16(22, numberOfChannels, true); // nChannels
        dataView.setUint32(24, sampleRate, true); // nSamplesPerSec
        dataView.setUint32(28, bytesPerSec, true); // nAvgBytesPerSec
        dataView.setUint16(32, bytesPerFrame, true); // nBlockAlign
        dataView.setUint16(34, bitsPerSample, true); // wBitsPerSample
        if (fmtChunkSize > 16) {
            dataView.setUint16(36, 0, true);
        } // cbSize (extension size)
        var p = 20 + fmtChunkSize;
        setString(p, "data"); // chunk ID
        dataView.setUint32(p + 4, sampleDataLength, true);
    } // chunk size
    function writeSampleData_int16() {
        var offs = headerLength;
        for (var frameNo = 0; frameNo < numberOfFrames; frameNo++) {
            for (var channelNo = 0; channelNo < numberOfChannels; channelNo++) {
                var sampleValueFloat = channelData[channelNo][frameNo];
                var sampleValueInt16 = convertFloatSampleToInt16(sampleValueFloat);
                dataView.setInt16(offs, sampleValueInt16, true);
                offs += 2;
            }
        }
    }
    function writeSampleData_float32() {
        var offs = headerLength;
        for (var frameNo = 0; frameNo < numberOfFrames; frameNo++) {
            for (var channelNo = 0; channelNo < numberOfChannels; channelNo++) {
                var sampleValueFloat = channelData[channelNo][frameNo];
                dataView.setFloat32(offs, sampleValueFloat, true);
                offs += 4;
            }
        }
    }
    // When converting PCM sample values from float to signed 16 bit, the midpoint must remain 0.
    // There are several options for the 16-bit quantization:
    //  Option A: [-1 .. 1]       ==> [-32768 .. 32767]   asymetric
    //  Option B: [-1 .. 1]       ==> [-32767 .. 32767]   symetric, bit patterns are distorted
    //  Option C: [-1 .. 0.99997] ==> [-32768 .. 32767]   symetric, +1 value is clipped
    function convertFloatSampleToInt16(v) {
        // Option A:
        //   return v < 0 ?
        //      Math.max(-32768, Math.round(v * 32768)) :
        //      Math.min( 32767, Math.round(v * 32767)); }
        // Option B:
        //    return Math.max(-32768, Math.min(32767, Math.round(v * 32767))); }
        // Option C:
        return Math.max(-32768, Math.min(32767, Math.round(v * 32768)));
    }
    function setString(offset, value) {
        for (var p = 0; p < value.length; p++) {
            dataView.setUint8(offset + p, value.charCodeAt(p));
        }
    }
}
// Alias function names for backward compatibility with package versions < 1.0.4.
export { encodeWavFileFromAudioBuffer as encodeWavFile, encodeWavFileFromArrays as encodeWavFile2 };

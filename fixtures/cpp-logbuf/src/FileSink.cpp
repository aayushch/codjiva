#include "FileSink.h"

#include <filesystem>
#include <system_error>

namespace logbuf {

FileSink::FileSink(const std::string& path) : path_(path) {
    // The file may already hold records from an earlier run of the process.
    // Its current size is the starting value of bytesWritten_, so that the
    // disk budget in LogWriter covers the whole file.
    std::error_code ignored;
    const auto existingSize = std::filesystem::file_size(path_, ignored);
    if (!ignored) {
        bytesWritten_ = static_cast<std::uint64_t>(existingSize);
    }

    out_.open(path_, std::ios::out | std::ios::app | std::ios::binary);
    if (!out_.is_open()) {
        throw SinkError("cannot open log file " + path_);
    }
}

FileSink::~FileSink() {
    // std::ofstream writes its buffer and closes the file here. A failure at
    // this point cannot be reported, because a destructor must not throw.
    if (out_.is_open()) {
        out_.close();
    }
}

void FileSink::write(std::string_view bytes) {
    out_.write(bytes.data(), static_cast<std::streamsize>(bytes.size()));
    if (!out_) {
        throw SinkError("write to " + path_ + " failed");
    }
    bytesWritten_ += bytes.size();
}

void FileSink::sync() {
    out_.flush();
    if (!out_) {
        throw SinkError("flush of " + path_ + " failed");
    }
}

}  // namespace logbuf

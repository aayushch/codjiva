#pragma once

#include <cstdint>
#include <fstream>
#include <stdexcept>
#include <string>
#include <string_view>

namespace logbuf {

/// Thrown by FileSink when the log file cannot be opened, written or synced.
class SinkError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

/// Appends bytes to one log file and counts how large the file is.
/// FileSink does no buffering of its own beyond the stream's buffer.
/// LogWriter decides when to call write() and sync().
class FileSink {
public:
    /// Opens the file at `path` for appending and creates it if it is missing.
    /// Throws SinkError if the file cannot be opened.
    explicit FileSink(const std::string& path);

    /// Closes the file. Bytes still in the stream's buffer are written first.
    ~FileSink();

    FileSink(const FileSink&) = delete;
    FileSink& operator=(const FileSink&) = delete;

    /// Appends `bytes` to the file. Throws SinkError if the stream reports a failure.
    void write(std::string_view bytes);

    /// Pushes the stream's buffer to the operating system.
    /// Throws SinkError if the stream reports a failure.
    void sync();

    /// Size of the file in bytes. It starts at the size the file had when it
    /// was opened and grows with every write().
    std::uint64_t bytesWritten() const noexcept { return bytesWritten_; }

    const std::string& path() const noexcept { return path_; }

private:
    std::string path_;
    std::ofstream out_;
    std::uint64_t bytesWritten_ = 0;
};

}  // namespace logbuf

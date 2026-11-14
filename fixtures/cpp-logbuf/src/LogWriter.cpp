#include "LogWriter.h"

#include <chrono>
#include <sstream>
#include <thread>
#include <utility>

namespace logbuf {

namespace {

/// Buffered bytes at which append() flushes the buffer to the sink.
constexpr std::size_t kFlushThresholdBytes = 64 * 1024;

/// Records from one source after which that source's records are written
/// without their context.
constexpr std::uint64_t kSourceSoftLimit = 1'000;

/// Records from one source after which that source's records are only
/// counted per severity and no longer written.
constexpr std::uint64_t kSourceHardLimit = 10'000;

/// File size at which the writer switches to WriterMode::Terse.
constexpr std::uint64_t kDiskSoftBytes = 48ull * 1024 * 1024;

/// File size at which append() throws DiskBudgetExceeded.
constexpr std::uint64_t kDiskHardBytes = 64ull * 1024 * 1024;

/// Longest message, in characters, that is written in WriterMode::Terse.
constexpr std::size_t kTerseMessageChars = 120;

constexpr std::array<const char*, kSeverityCount> kSeverityNames = {"DEBUG", "INFO", "WARN", "ERROR"};

std::size_t severityIndex(Severity severity) {
    return static_cast<std::size_t>(severity);
}

}  // namespace

DiskBudgetExceeded::DiskBudgetExceeded(std::uint64_t fileBytes)
    : std::runtime_error("log file is " + std::to_string(fileBytes) + " bytes, over the hard budget"),
      fileBytes_(fileBytes) {}

LogWriter::LogWriter(FileSink& sink, Severity minSeverity) : sink_(sink), minSeverity_(minSeverity) {}

/// The destructor runs when the writer goes out of scope. That includes the
/// case where an exception such as DiskBudgetExceeded is leaving the scope.
/// It writes one summary line per summarised source and then the buffer.
LogWriter::~LogWriter() {
    try {
        bufferSourceSummaries();
        flush();
    } catch (const std::exception&) {
        // A destructor must not throw. If the sink fails here, the lines
        // still in buffer_ are lost.
    }
}

/// Entry point for one record. A record has one of five outcomes.
///   - The writer is in WriterMode::Exhausted: the record is dropped.
///   - The record is below minSeverity_: the record is dropped.
///   - The record is an audit record: it is written to the sink at once.
///   - The record's source is in SourceMode::Summary: it is only counted.
///   - Otherwise the record goes through the four steps and into buffer_.
/// Throws DiskBudgetExceeded when the file reaches kDiskHardBytes.
void LogWriter::append(LogRecord record) {
    if (mode_ == WriterMode::Exhausted) {
        ++droppedAfterBudget_;
        return;
    }
    if (record.severity < minSeverity_) {
        ++droppedBelowMinimum_;
        return;
    }

    SourceState& source = sources_[record.source];
    ++source.recordCount;

    if (record.kind == RecordKind::Audit) {
        stampTime(record);
        assignSequence(record);
        formatPrefix(record);
        writeAuditNow(record);
        enforceDiskBudget();
        return;
    }

    updateSourceMode(source);
    if (source.mode == SourceMode::Summary) {
        ++source.summaryCounts[severityIndex(record.severity)];
        return;
    }

    stampTime(record);
    assignSequence(record);
    formatPrefix(record);
    captureContext(record, source);
    bufferLine(renderLine(record));
    enforceDiskBudget();
}

/// Applies the per-source limits to the source's record count.
/// Above kSourceSoftLimit a source in Full mode switches to NoContext.
/// Above kSourceHardLimit the source switches to Summary.
void LogWriter::updateSourceMode(SourceState& source) const {
    if (source.recordCount > kSourceHardLimit) {
        source.mode = SourceMode::Summary;
    } else if (source.recordCount > kSourceSoftLimit && source.mode == SourceMode::Full) {
        source.mode = SourceMode::NoContext;
    }
}

/// Step one. Sets timestampMs to the current wall-clock time.
void LogWriter::stampTime(LogRecord& record) const {
    const auto sinceEpoch = std::chrono::system_clock::now().time_since_epoch();
    record.timestampMs = std::chrono::duration_cast<std::chrono::milliseconds>(sinceEpoch).count();
}

/// Step two. Gives the record the next sequence number of this writer.
void LogWriter::assignSequence(LogRecord& record) {
    record.sequence = nextSequence_++;
}

/// Step three. Builds the text that starts the line: time, sequence number,
/// severity name and source. Audit records also get the word AUDIT.
void LogWriter::formatPrefix(LogRecord& record) const {
    record.prefix = std::to_string(record.timestampMs) + " #" + std::to_string(record.sequence) + ' ' +
                    kSeverityNames[severityIndex(record.severity)] + " [" + record.source + "] ";
    if (record.kind == RecordKind::Audit) {
        record.prefix += "AUDIT ";
    }
}

/// Step four. Fills record.context with the calling thread's id and the
/// record's fields. It does this only when the writer is in WriterMode::Full
/// and the source is in SourceMode::Full. In every other case the context
/// stays empty.
void LogWriter::captureContext(LogRecord& record, const SourceState& source) const {
    if (mode_ != WriterMode::Full || source.mode != SourceMode::Full) {
        return;
    }
    std::ostringstream out;
    out << "thread=" << std::this_thread::get_id();
    for (const auto& [key, value] : record.fields) {
        out << ' ' << key << '=' << value;
    }
    record.context = out.str();
}

/// Builds the line that is written for a record. In WriterMode::Terse a
/// message longer than kTerseMessageChars is cut to that length.
std::string LogWriter::renderLine(const LogRecord& record) const {
    std::string line = record.prefix;
    if (mode_ == WriterMode::Terse && record.message.size() > kTerseMessageChars) {
        line.append(record.message, 0, kTerseMessageChars);
        line += "...";
    } else {
        line += record.message;
    }
    if (!record.context.empty()) {
        line += " {" + record.context + '}';
    }
    line += '\n';
    return line;
}

/// Adds a line to buffer_ and flushes when the buffer holds
/// kFlushThresholdBytes or more.
void LogWriter::bufferLine(std::string line) {
    bufferedBytes_ += line.size();
    buffer_.push_back(std::move(line));
    if (bufferedBytes_ >= kFlushThresholdBytes) {
        flush();
    }
}

/// Writes an audit record straight to the sink and syncs it. The line can be
/// in the file before buffered lines that have lower sequence numbers.
void LogWriter::writeAuditNow(const LogRecord& record) {
    sink_.write(renderLine(record));
    sink_.sync();
}

/// Applies the file size budget after a record was buffered or written.
/// The size checked is the sink's file size plus the bytes still in buffer_.
/// At kDiskSoftBytes the writer switches from Full to Terse.
/// At kDiskHardBytes the writer switches to Exhausted, flushes the buffer so
/// that the current record is in the file, and throws DiskBudgetExceeded.
void LogWriter::enforceDiskBudget() {
    const std::uint64_t projectedBytes = sink_.bytesWritten() + bufferedBytes_;
    if (projectedBytes >= kDiskHardBytes) {
        mode_ = WriterMode::Exhausted;
        flush();
        throw DiskBudgetExceeded(sink_.bytesWritten());
    }
    if (projectedBytes >= kDiskSoftBytes && mode_ == WriterMode::Full) {
        mode_ = WriterMode::Terse;
    }
}

/// Writes every buffered line to the sink as one block and empties buffer_.
/// Throws SinkError if the sink fails. In that case buffer_ keeps its lines.
void LogWriter::flush() {
    if (buffer_.empty()) {
        return;
    }
    std::string block;
    block.reserve(bufferedBytes_);
    for (const std::string& line : buffer_) {
        block += line;
    }
    sink_.write(block);
    sink_.sync();
    buffer_.clear();
    bufferedBytes_ = 0;
}

/// Adds one line to buffer_ for every source in SourceMode::Summary. The line
/// lists how many of the source's records were counted for each severity.
void LogWriter::bufferSourceSummaries() {
    for (const auto& [name, source] : sources_) {
        if (source.mode != SourceMode::Summary) {
            continue;
        }
        std::string line = "summary [" + name + "]";
        for (std::size_t i = 0; i < kSeverityCount; ++i) {
            line += std::string(" ") + kSeverityNames[i] + '=' + std::to_string(source.summaryCounts[i]);
        }
        line += '\n';
        bufferedBytes_ += line.size();
        buffer_.push_back(std::move(line));
    }
}

}  // namespace logbuf

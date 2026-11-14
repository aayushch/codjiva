#pragma once

#include <array>
#include <cstddef>
#include <cstdint>
#include <map>
#include <stdexcept>
#include <string>
#include <vector>

#include "FileSink.h"

namespace logbuf {

enum class Severity { Debug = 0, Info, Warning, Error };
inline constexpr std::size_t kSeverityCount = 4;

/// Audit records are written to the sink at once. Normal records are buffered.
enum class RecordKind { Normal, Audit };

/// One log record. The caller fills source, severity, kind, message and
/// fields. LogWriter::append fills the four members below them.
struct LogRecord {
    std::string source;
    Severity severity = Severity::Info;
    RecordKind kind = RecordKind::Normal;
    std::string message;
    std::map<std::string, std::string> fields;

    std::int64_t timestampMs = 0;
    std::uint64_t sequence = 0;
    std::string prefix;
    std::string context;
};

/// How much detail the whole writer keeps. The writer moves from Full to
/// Terse to Exhausted and never moves back.
enum class WriterMode { Full, Terse, Exhausted };

/// How much detail one source keeps. A source moves from Full to NoContext
/// to Summary and never moves back.
enum class SourceMode { Full, NoContext, Summary };

/// Per-source counters, keyed by LogRecord::source in LogWriter::sources_.
struct SourceState {
    std::uint64_t recordCount = 0;
    SourceMode mode = SourceMode::Full;
    /// Records counted instead of written while the source is in Summary
    /// mode, indexed by Severity.
    std::array<std::uint64_t, kSeverityCount> summaryCounts{};
};

/// Thrown by LogWriter::append when the log file reaches the hard size budget.
class DiskBudgetExceeded : public std::runtime_error {
public:
    explicit DiskBudgetExceeded(std::uint64_t fileBytes);
    std::uint64_t fileBytes() const noexcept { return fileBytes_; }

private:
    std::uint64_t fileBytes_;
};

/// Buffers log records in memory and writes them to a FileSink in blocks.
/// A LogWriter is not thread-safe. The owner calls it from one thread.
class LogWriter {
public:
    /// The sink must outlive the writer. Records below `minSeverity` are dropped.
    LogWriter(FileSink& sink, Severity minSeverity);

    /// Writes the per-source summaries and the buffered records to the sink.
    ~LogWriter();

    LogWriter(const LogWriter&) = delete;
    LogWriter& operator=(const LogWriter&) = delete;

    void append(LogRecord record);
    void flush();

    WriterMode mode() const noexcept { return mode_; }
    std::uint64_t droppedBelowMinimum() const noexcept { return droppedBelowMinimum_; }
    std::uint64_t droppedAfterBudget() const noexcept { return droppedAfterBudget_; }

private:
    void updateSourceMode(SourceState& source) const;
    void stampTime(LogRecord& record) const;
    void assignSequence(LogRecord& record);
    void formatPrefix(LogRecord& record) const;
    void captureContext(LogRecord& record, const SourceState& source) const;
    std::string renderLine(const LogRecord& record) const;
    void bufferLine(std::string line);
    void writeAuditNow(const LogRecord& record);
    void enforceDiskBudget();
    void bufferSourceSummaries();

    FileSink& sink_;
    Severity minSeverity_;
    WriterMode mode_ = WriterMode::Full;
    std::vector<std::string> buffer_;
    std::size_t bufferedBytes_ = 0;
    std::uint64_t nextSequence_ = 1;
    std::uint64_t droppedBelowMinimum_ = 0;
    std::uint64_t droppedAfterBudget_ = 0;
    std::map<std::string, SourceState> sources_;
};

}  // namespace logbuf

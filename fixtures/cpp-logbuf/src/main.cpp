#include <cstddef>
#include <iostream>
#include <optional>
#include <sstream>
#include <string>
#include <utility>

#include "FileSink.h"
#include "LogWriter.h"

namespace {

constexpr int kExitOk = 0;
constexpr int kExitSinkFailure = 1;
constexpr int kExitBudgetExceeded = 2;

std::optional<logbuf::Severity> parseSeverity(const std::string& text) {
    if (text == "debug") return logbuf::Severity::Debug;
    if (text == "info") return logbuf::Severity::Info;
    if (text == "warning") return logbuf::Severity::Warning;
    if (text == "error") return logbuf::Severity::Error;
    return std::nullopt;
}

/// Parses one input line of the form `source|severity|kind|message`.
/// `kind` is `audit` for an audit record and anything else for a normal one.
/// Returns std::nullopt if a field is missing or the severity is unknown.
std::optional<logbuf::LogRecord> parseLine(const std::string& line) {
    std::istringstream in(line);
    std::string source;
    std::string severityText;
    std::string kind;
    std::string message;
    if (!std::getline(in, source, '|') || !std::getline(in, severityText, '|') ||
        !std::getline(in, kind, '|') || !std::getline(in, message)) {
        return std::nullopt;
    }
    const auto severity = parseSeverity(severityText);
    if (!severity) {
        return std::nullopt;
    }

    logbuf::LogRecord record;
    record.source = std::move(source);
    record.severity = *severity;
    record.kind = kind == "audit" ? logbuf::RecordKind::Audit : logbuf::RecordKind::Normal;
    record.message = std::move(message);
    return record;
}

/// Reads lines from `in` until end of input and appends each parsed record
/// to the writer. Returns the number of lines that could not be parsed.
/// A DiskBudgetExceeded thrown by LogWriter::append passes through this
/// function to the caller.
std::size_t replay(std::istream& in, logbuf::LogWriter& writer) {
    std::size_t unparsedLines = 0;
    std::string line;
    while (std::getline(in, line)) {
        if (auto record = parseLine(line)) {
            writer.append(std::move(*record));
        } else {
            ++unparsedLines;
        }
    }
    return unparsedLines;
}

}  // namespace

int main(int argc, char** argv) {
    const std::string path = argc > 1 ? argv[1] : "service.log";
    try {
        logbuf::FileSink sink(path);
        try {
            // The writer lives only inside this block. When the block ends,
            // normally or because of an exception, ~LogWriter flushes the
            // buffered records to the sink.
            logbuf::LogWriter writer(sink, logbuf::Severity::Info);
            const std::size_t unparsedLines = replay(std::cin, writer);
            writer.flush();
            std::cerr << "logreplay: done, " << unparsedLines << " unparsed lines, "
                      << writer.droppedBelowMinimum() << " records below minimum severity\n";
        } catch (const logbuf::DiskBudgetExceeded& error) {
            // The writer is already destroyed here, so every record accepted
            // before the budget was reached is in the file. The remaining
            // input is not read.
            std::cerr << "logreplay: stopped, " << error.what() << '\n';
            return kExitBudgetExceeded;
        }
    } catch (const logbuf::SinkError& error) {
        std::cerr << "logreplay: " << error.what() << '\n';
        return kExitSinkFailure;
    }
    return kExitOk;
}

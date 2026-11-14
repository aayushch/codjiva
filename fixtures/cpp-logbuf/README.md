# logbuf
A buffered log writer library for C++17 services, with a small `logreplay` tool that feeds it from standard input.
Records are stamped, numbered and formatted, then held in memory and written to one log file in blocks.
Noisy sources lose detail first, and a file size budget stops the writer before the disk fills.
Build with `cmake -B build && cmake --build build`, then run `./build/logreplay service.log < records.txt`.

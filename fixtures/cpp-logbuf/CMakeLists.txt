cmake_minimum_required(VERSION 3.16)
project(logbuf VERSION 1.4.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_library(logbuf STATIC
    src/LogWriter.cpp
    src/FileSink.cpp
)
target_include_directories(logbuf PUBLIC include)
target_compile_options(logbuf PRIVATE -Wall -Wextra -Wpedantic)

add_executable(logreplay src/main.cpp)
target_link_libraries(logreplay PRIVATE logbuf)

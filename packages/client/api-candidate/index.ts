/**
 * Compile-only alias for the implemented beta candidate surface.
 *
 * Consumer spikes import this unexported path so their positive and negative
 * assertions are checked against the real package entry point rather than a
 * second handwritten interface that can drift from the implementation.
 */
export * from "../src/index.js";

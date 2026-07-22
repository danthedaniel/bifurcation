#version 300 es

precision highp float;

uniform vec2 u_sim_resolution; // State texture size in texels
uniform vec2 u_size; // Size of view space (world units)
uniform vec2 u_center; // Center in view space

// State layout: .x = current orbit value x_n, .y = last-hit iteration index
// (-1.0 = never hit), .z/.w unused.
layout(location = 0) out vec4 outState;

void main() {
    // Every column shares the same r, every row the same y; the orbit is
    // seeded with x_0 = 0.5 (in the attracting basin for all r of interest).
    // r and y are recomputed per-pass in step.frag from gl_FragCoord, so init
    // does not need to store them.
    outState = vec4(0.5, -1.0, 0.0, 0.0);
}

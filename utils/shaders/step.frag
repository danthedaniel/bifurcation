#version 300 es

precision highp float;

uniform sampler2D u_state;
uniform vec2 u_sim_resolution; // State texture size in texels
uniform vec2 u_size; // Size of view space (world units)
uniform vec2 u_center; // Center in view space
uniform int u_steps; // Iterations to advance this pass
uniform int u_iteration_base; // Global iteration index of the first step

// State layout: .x = current orbit value x_n, .y = last-hit iteration index
// (-1.0 = never hit), .z/.w unused.
layout(location = 0) out vec4 outState;

void main() {
    // Recompute this texel's (r, y) in view space (same mapping as init).
    vec2 uv = gl_FragCoord.xy / u_sim_resolution - vec2(0.5);
    vec2 view = uv * u_size + u_center;
    float r = view.x;
    float y = view.y;

    // Half the texel's world-space height = bin half-width for hit detection.
    float halfBin = 0.5 * u_size.y / u_sim_resolution.y;

    ivec2 texel = ivec2(gl_FragCoord.xy);
    vec4 state = texelFetch(u_state, texel, 0);
    float x = state.x;
    float lastHit = state.y;

    // A frozen orbit (diverged / NaN) keeps its last-hit record but stops
    // iterating so NaN poisoning can't spread when the view is panned to
    // r > 4 or r < 0.
    bool frozen = isnan(x) || abs(x) > 4.0;

    for (int i = 0; i < u_steps; i++) {
        if (frozen) break;
        x = r * x * (1.0 - x);
        if (isnan(x) || abs(x) > 4.0) {
            frozen = true;
            x = clamp(x, -4.0, 4.0);
        }
        if (abs(x - y) <= halfBin) {
            lastHit = float(u_iteration_base + i + 1);
        }
    }

    outState = vec4(x, lastHit, 0.0, 0.0);
}

#version 300 es

precision highp float;

uniform sampler2D u_state;
uniform vec2 u_canvas_resolution; // Drawing buffer size in pixels
// View transform applied to the sample coordinate before sampling the cached
// state. Identity (1, 1)/(0, 0) re-displays the cached frame unchanged.
uniform vec2 u_uv_scale;  // identity: (1, 1)
uniform vec2 u_uv_offset; // identity: (0, 0)
uniform int u_step_count; // Total iterations N (e.g. 600)

out vec4 fragColor;

vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

void main() {
    // The state texture may be lower resolution than the canvas; nearest
    // filtering upscales it with a pixelated look.
    vec2 uv = (gl_FragCoord.xy / u_canvas_resolution) * u_uv_scale + u_uv_offset;

    // Fragments outside [0,1] are exposed when zooming out beyond the cached
    // frame. Render them black instead of letting CLAMP_TO_EDGE smear the
    // border texels outward.
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    vec4 state = texture(u_state, uv);
    float lastHit = state.y;

    // Never hit, or last hit within the first 100 transient iterations.
    if (lastHit < 101.0) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }

    // Hue runs from 0 at iteration 101 to 0.5 (half the hue wheel) at N.
    float hue = 0.5 * (lastHit - 101.0) / float(u_step_count - 101);
    float saturation = 0.9;
    float value = 1.0;
    vec3 color = hsv2rgb(vec3(hue, saturation, value));

    fragColor = vec4(color, 1.0);
}

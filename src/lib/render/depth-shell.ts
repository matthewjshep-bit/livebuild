import * as THREE from "three";

/**
 * The 2.5D shell: one photo, displaced into space by its depth map.
 *
 * A shell is a single sheet of geometry, so it can stretch across a depth jump
 * but can never reveal what sits behind one - nothing was ever recorded there.
 * Rather than let those regions smear into rubber sheets, the vertex stage
 * measures the local depth gradient and the fragment stage discards anything
 * too steep. A clean hole reads as an edge; a stretched triangle reads as a bug.
 *
 * Depth arrives as 24-bit millimetres packed across RGB (see
 * pipeline/make_demo_assets.py). That texture carries data, not colour, so it
 * must be uploaded unfiltered and unconverted.
 */

export const SHELL_SEGMENTS = 300;

const vertexShader = /* glsl */ `
  uniform sampler2D uDepth;
  uniform vec2  uStep;
  uniform float uTanX;
  uniform float uTanY;
  uniform float uMaxDepth;

  varying vec2  vUv;
  varying float vStretch;

  float readDepth(vec2 uv) {
    vec3 packed = texture2D(uDepth, uv).rgb * 255.0;
    return (packed.r * 65536.0 + packed.g * 256.0 + packed.b) / 1000.0;
  }

  void main() {
    vUv = uv;

    float depth = readDepth(uv);

    // The ray this pixel was captured along, in the shell's own frame:
    // +Z forward, +X right, +Y up, matching the node's heading rotation.
    vec3 ray = normalize(vec3(
      (uv.x - 0.5) * 2.0 * uTanX,
      (uv.y - 0.5) * 2.0 * uTanY,
      1.0
    ));

    // Distinguishing a genuine silhouette from a surface merely seen edge-on.
    //
    // The obvious test - how much depth changes between neighbours - is wrong,
    // and visibly so: a floor viewed at a grazing angle changes depth enormously
    // from one vertex to the next while being perfectly continuous, so it gets
    // cut to ribbons along with the real object edges.
    //
    // Disparity (1/depth) is affine across the image for *any* plane, whatever
    // its angle. So its second difference is zero on every flat surface and
    // spikes only where the surface actually breaks. That is the signal we want.
    float disparity = 1.0 / max(depth, 0.05);
    float il = 1.0 / max(readDepth(uv - vec2(uStep.x, 0.0)), 0.05);
    float ir = 1.0 / max(readDepth(uv + vec2(uStep.x, 0.0)), 0.05);
    float id = 1.0 / max(readDepth(uv - vec2(0.0, uStep.y)), 0.05);
    float iu = 1.0 / max(readDepth(uv + vec2(0.0, uStep.y)), 0.05);

    float curvature = max(abs(il - 2.0 * disparity + ir),
                          abs(id - 2.0 * disparity + iu));
    vStretch = curvature / max(disparity, 1e-4);

    // Depth is unreliable past the far clamp - typically a window looking out
    // at sky, where the model has nothing to anchor on. Park those samples at
    // the clamp so they behave like a backdrop instead of flying to infinity.
    float d = min(depth, uMaxDepth);

    gl_Position = projectionMatrix * modelViewMatrix * vec4(ray * d, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uPhoto;
  uniform float uOpacity;
  uniform float uStretchLimit;

  varying vec2  vUv;
  varying float vStretch;

  void main() {
    if (vStretch > uStretchLimit) discard;

    vec4 photo = texture2D(uPhoto, vUv);

    // Fade the last stretch before the cut so holes have a soft edge rather
    // than a jagged one, which is far less noticeable while the camera moves.
    float fade = 1.0 - smoothstep(uStretchLimit * 0.6, uStretchLimit, vStretch);

    gl_FragColor = vec4(photo.rgb, photo.a * uOpacity * fade);
    #include <colorspace_fragment>
  }
`;

export type ShellUniforms = {
  photo: THREE.Texture;
  depth: THREE.Texture;
  fovDeg: number;
  aspect: number;
  maxDepth?: number;
  stretchLimit?: number;
};

export function createShellMaterial({
  photo,
  depth,
  fovDeg,
  aspect,
  maxDepth = 40,
  stretchLimit = 0.06,
}: ShellUniforms): THREE.ShaderMaterial {
  const tanX = Math.tan((fovDeg * Math.PI) / 180 / 2);

  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    transparent: true,
    // Both faces, because the shell is viewed from slightly off-axis and a
    // back-facing triangle near a hole would otherwise punch a gap in the wall.
    side: THREE.DoubleSide,
    depthWrite: true,
    uniforms: {
      uPhoto: { value: photo },
      uDepth: { value: depth },
      uStep: {
        value: new THREE.Vector2(1 / SHELL_SEGMENTS, 1 / SHELL_SEGMENTS),
      },
      uTanX: { value: tanX },
      uTanY: { value: tanX / aspect },
      uMaxDepth: { value: maxDepth },
      uOpacity: { value: 1 },
      uStretchLimit: { value: stretchLimit },
    },
  });
}

/**
 * Depth textures carry numbers, not colour. Any filtering would average packed
 * bytes across a depth edge and produce a value that means nothing, and sRGB
 * conversion would rescale them outright.
 */
export function configureDepthTexture(texture: THREE.Texture): THREE.Texture {
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function configurePhotoTexture(texture: THREE.Texture): THREE.Texture {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

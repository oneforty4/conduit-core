// The sandbox's scene dressing: light for the glTF models, whose materials are physically based and
// render black without it, and a ground. Games own their visuals (CONCEPT.md principle 6), so, like
// a game's client app (docs/consuming.md 5), this file imports three. It is the only sandbox file
// that may: the root eslint.config.js lists it in `renderGlobs` (docs/consuming.md 1).
import type { Vec3 } from '@conduit/math';
import type { RenderWorld } from '@conduit/render';
import {
  Color,
  DataTexture,
  DirectionalLight,
  HemisphereLight,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  RepeatWrapping,
  SRGBColorSpace,
} from 'three';
import { CELL_SIZE, GRID_COLS, GRID_ROWS } from '../shared/constants.ts';

/** Side of one ground grid square, in metres. */
export const GROUND_SQUARE = 8;
/** Page background (index.html) and clear colour. */
const BACKGROUND = 0x101014;
/** Texels per grid square; the one-texel border of each square is its line. */
const GRID_TEXELS = 64;

/**
 * One grid square: a dark fill with a lighter one-texel line along two edges, repeated over the
 * ground. A textured plane rather than a `GridHelper`: SwiftShader (headless browser checks) drops
 * the `GridHelper` lines that run past the camera.
 */
function gridTexture(): DataTexture {
  const data = new Uint8Array(GRID_TEXELS * GRID_TEXELS * 4);
  for (let y = 0; y < GRID_TEXELS; y++) {
    for (let x = 0; x < GRID_TEXELS; x++) {
      const i = (y * GRID_TEXELS + x) * 4;
      const v = x === 0 || y === 0 ? 92 : 40;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v + 8;
      data[i + 3] = 255;
    }
  }
  const texture = new DataTexture(data, GRID_TEXELS, GRID_TEXELS);
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = 8;
  texture.colorSpace = SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

/**
 * Adds a hemisphere light, a directional "sun" and a grid-textured ground plane covering the whole
 * world (a line every `GROUND_SQUARE` m, kept under the world's floating origin) to `world`'s scene.
 * Returns a function that removes and disposes them.
 */
export function dressScene(world: RenderWorld): () => void {
  const scene = world.host.scene;
  const background = scene.background;
  scene.background = new Color(BACKGROUND);

  const sky = new HemisphereLight(0xe6eeff, 0x3d3428, 1.5);
  // A directional light shines from its position towards its target at the scene origin: only the
  // direction matters, so the floating origin does not move it.
  const sun = new DirectionalLight(0xfff4e0, 2.5);
  sun.position.set(-0.45, 1, -0.3);
  scene.add(sky, sun);

  const width = CELL_SIZE * GRID_COLS;
  const depth = CELL_SIZE * GRID_ROWS;
  const texture = gridTexture();
  texture.repeat.set(width / GROUND_SQUARE, depth / GROUND_SQUARE);
  const ground = new Mesh(
    new PlaneGeometry(width, depth),
    new MeshStandardMaterial({ map: texture, roughness: 1, metalness: 0 }),
  );
  ground.name = 'sandbox-ground';
  ground.rotation.x = -Math.PI / 2; // the plane's +Z normal becomes +Y
  const place = (origin: Readonly<Vec3>): void => {
    ground.position.set(width / 2 - origin.x, -0.01, depth / 2 - origin.z);
  };
  place(world.floatingOrigin);
  world.root.add(ground);
  const off = world.on('floatingOrigin', ({ origin }) => place(origin));

  return () => {
    off();
    sky.removeFromParent();
    sun.removeFromParent();
    sun.dispose();
    ground.removeFromParent();
    ground.geometry.dispose();
    ground.material.dispose();
    texture.dispose();
    scene.background = background;
  };
}

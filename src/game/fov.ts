export function computeFov(
  originX: number,
  originZ: number,
  radius: number,
  isBlocked: (x: number, z: number) => boolean,
): Set<string> {
  const visible = new Set<string>();
  visible.add(`${originX},${originZ}`);
  for (let octant = 0; octant < 4; octant++) {
    scanOctant(visible, originX, originZ, radius, octant, isBlocked);
  }
  return visible;
}

// Four cardinal quadrants, each scanning two octants via row/col symmetry.
// dx/dz multipliers for (row, col) in each quadrant.
const QUADRANTS: [number, number][] = [
  [1, 0],  // +x
  [-1, 0], // -x
  [0, 1],  // +z
  [0, -1], // -z
];

function scanOctant(
  visible: Set<string>,
  ox: number,
  oz: number,
  radius: number,
  quadrant: number,
  isBlocked: (x: number, z: number) => boolean,
): void {
  const [rdx, rdz] = QUADRANTS[quadrant];
  // cdx/cdz: perpendicular direction
  const cdx = rdz !== 0 ? 1 : 0;
  const cdz = rdx !== 0 ? 1 : 0;

  // Scan two octants: positive and negative perpendicular
  for (const sign of [1, -1]) {
    scanSlope(visible, ox, oz, radius, rdx, rdz, cdx * sign, cdz * sign, 1, 0.0, 1.0, isBlocked);
  }
}

function scanSlope(
  visible: Set<string>,
  ox: number,
  oz: number,
  radius: number,
  rdx: number,
  rdz: number,
  cdx: number,
  cdz: number,
  depth: number,
  startSlope: number,
  endSlope: number,
  isBlocked: (x: number, z: number) => boolean,
): void {
  if (depth > radius) return;
  if (startSlope >= endSlope) return;

  let prevBlocked = false;
  let savedSlope = startSlope;

  for (let col = Math.ceil(depth * startSlope - 0.5); col <= Math.floor(depth * endSlope + 0.5); col++) {
    const mapX = ox + depth * rdx + col * cdx;
    const mapZ = oz + depth * rdz + col * cdz;

    if (depth * depth + col * col <= radius * radius) {
      visible.add(`${mapX},${mapZ}`);
    }

    const curBlocked = isBlocked(mapX, mapZ);

    if (prevBlocked && !curBlocked) {
      savedSlope = (col - 0.5) / depth;
    }
    if (!prevBlocked && curBlocked) {
      scanSlope(
        visible, ox, oz, radius, rdx, rdz, cdx, cdz,
        depth + 1, savedSlope, (col - 0.5) / depth, isBlocked,
      );
    }
    prevBlocked = curBlocked;
  }
  if (!prevBlocked) {
    scanSlope(
      visible, ox, oz, radius, rdx, rdz, cdx, cdz,
      depth + 1, savedSlope, endSlope, isBlocked,
    );
  }
}

"""Build the sandbox `crate` and `vehicle` models from scratch and export them per docs/assets.md section 5.

Usage (Blender 5.2 LTS, headless; paths relative to the repository root):

    Blender -b --factory-startup --python-exit-code 1 \
        --python examples/sandbox/scripts/make-models.py [-- --out <dir>]

Writes <dir>/crate.blend, <dir>/crate.glb, <dir>/vehicle.blend and <dir>/vehicle.glb. <dir> defaults to
examples/sandbox/assets. Each .blend remembers EXPORT_OPTIONS, so File > Export > glTF 2.0 from the saved
file reproduces its .glb.

Conventions (docs/assets.md section 5):
- 1 Blender unit = 1 m. Models stand on the origin and face Blender -Y, which the +Y Up export turns into
  glTF +Z (forward = +Z, up = +Y, right = -X).
- One root empty named for the asset id, at the origin with identity transform. Everything else is parented
  to it.
- Visual meshes are the direct children `<root>_LOD0..2`, each with a `lodDistance` custom property (glTF extra).
  Their geometry is modelled in place, so every mesh node already has an identity transform (nothing to Ctrl+A).
- `<root>_COL_box` is a 1 m cube (vertices at +-0.5) whose object location, rotation and scale are the collider:
  scale is the full box size, so halfExtents = scale * 0.5. It is hidden from render and drawn as wire.
- Sockets are `SOCKET_<name>` empties. Their local forward axis is Blender -Y, which becomes glTF +Z.
"""

import argparse
import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

# docs/assets.md 5.1 mapped to the option names of Blender 5.2's glTF exporter (io_scene_gltf2 5.2.x).
# The comments give each option's place in the export dialog.
EXPORT_OPTIONS = {
    'export_format': 'GLB',                         # Format: glTF Binary (.glb); images embedded
    'export_yup': True,                             # Transform > +Y Up
    'export_apply': True,                           # Data > Mesh > Apply Modifiers
    'export_extras': True,                          # Include > Data > Custom Properties (-> extras)
    'export_draco_mesh_compression_enable': False,  # Data > Draco Compression: off
    'export_meshopt_compression_enable': False,     # Data > Meshopt Compression: off
    'export_image_format': 'AUTO',                  # Data > Material > Images: Automatic
    'export_materials': 'EXPORT',                   # Data > Material > Materials: Export
    'export_animations': True,                      # Animation (these models have no clips)
    'export_animation_mode': 'NLA_TRACKS',          # Animation > Animation Mode: NLA Tracks
    'use_selection': False,                         # Include > Limit to: everything off, otherwise the
    'use_visible': False,                           # hidden-from-render colliders could be dropped
    'use_renderable': False,
    'use_active_collection': False,
    'use_active_scene': False,
    'export_cameras': False,                        # Include > Data > Cameras
    'export_lights': False,                         # Include > Data > Punctual Lights
    'will_save_settings': True,                     # Remember Export Settings (stored in the .blend)
}

# Corner indices for add_box, counter-clockwise seen from outside so normals point out.
BOX_FACES = {
    '-z': (0, 3, 2, 1),
    '+z': (4, 5, 6, 7),
    '-y': (0, 1, 5, 4),
    '+y': (2, 3, 7, 6),
    '-x': (3, 0, 4, 7),
    '+x': (1, 2, 6, 5),
}


def parse_args():
    argv = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
    default_out = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
    parser = argparse.ArgumentParser(prog='make-models.py')
    parser.add_argument('--out', default=default_out, help='output directory (default: examples/sandbox/assets)')
    return parser.parse_args(argv)


def new_scene():
    """Start from an empty factory scene with metric units at scale 1.0."""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.context.preferences.filepaths.save_version = 0  # no .blend1 backups next to the sources
    units = bpy.context.scene.unit_settings
    units.system = 'METRIC'
    units.scale_length = 1.0
    units.length_unit = 'METERS'


def link(obj, parent):
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent  # parent is at the origin with identity transform, so no parent inverse is needed
    return obj


def empty(name, parent=None, display='PLAIN_AXES', size=0.5):
    obj = bpy.data.objects.new(name, None)
    obj.empty_display_type = display
    obj.empty_display_size = size
    return link(obj, parent)


def mesh_object(name, bm, materials, parent):
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    for mat in materials:
        mesh.materials.append(mat)
    return link(bpy.data.objects.new(name, mesh), parent)


def material(name, rgb, roughness, metallic=0.0):
    mat = bpy.data.materials.new(name)
    rgba = (*rgb, 1.0)
    mat.diffuse_color = rgba  # solid-mode viewport colour
    mat.use_backface_culling = True  # otherwise the exporter writes doubleSided: true
    if mat.node_tree is None:  # Blender < 5.0 creates materials without a node tree
        mat.use_nodes = True
    bsdf = next(node for node in mat.node_tree.nodes if node.type == 'BSDF_PRINCIPLED')
    bsdf.inputs['Base Color'].default_value = rgba
    bsdf.inputs['Roughness'].default_value = roughness
    bsdf.inputs['Metallic'].default_value = metallic
    return mat


def add_box(bm, lo, hi, mat=0, shape=None, skip=()):
    """Add a flat-shaded box from corner `lo` to `hi`.

    `shape(corner)` may move a corner (it receives and returns a Vector); faces named in `skip` ('-z', ...) are
    left out. Returns (corner verts, faces).
    """
    (x0, y0, z0), (x1, y1, z1) = lo, hi
    corners = [Vector(c) for c in ((x0, y0, z0), (x1, y0, z0), (x1, y1, z0), (x0, y1, z0),
                                   (x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1))]
    verts = [bm.verts.new(shape(c) if shape else c) for c in corners]
    faces = []
    for key, indices in BOX_FACES.items():
        if key in skip:
            continue
        face = bm.faces.new([verts[i] for i in indices])
        face.material_index = mat
        faces.append(face)
    return verts, faces


def add_wheel(bm, centre, radius, width, segments, mat):
    """Add a cylinder whose axis (the axle) runs along X: smooth tread, flat hub caps."""
    out = bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius, depth=width,
        matrix=Matrix.Translation(centre) @ Matrix.Rotation(math.pi / 2, 4, 'Y'))
    for face in {f for v in out['verts'] for f in v.link_faces}:
        face.material_index = mat
        face.smooth = len(face.verts) == 4


def set_lod_distances(lods, distances):
    for obj, distance in zip(lods, distances, strict=True):
        obj['lodDistance'] = float(distance)


def box_collider(root, centre, size):
    """`<root>_COL_box`: a 1 m cube whose object scale is the full box size (halfExtents = scale * 0.5)."""
    bm = bmesh.new()
    add_box(bm, (-0.5, -0.5, -0.5), (0.5, 0.5, 0.5))
    obj = mesh_object(f'{root.name}_COL_box', bm, [], root)
    obj.location = centre
    obj.scale = size
    obj.display_type = 'WIRE'
    obj.hide_render = True
    return obj


def socket(root, name, location, rotation=(0.0, 0.0, 0.0)):
    obj = empty(f'SOCKET_{name}', root, display='ARROWS', size=0.3)
    obj.location = location
    obj.rotation_euler = rotation
    return obj


def build_crate():
    """1 m crate standing on the origin."""
    new_scene()
    wood = material('wood', (0.45, 0.28, 0.13), roughness=0.8)
    root = empty('crate')

    # LOD0: a flat 8 cm frame and a 3 cm recessed panel on every face; the 12 outer edges carry bevel weight
    # for a Bevel modifier that the exporter applies.
    bm = bmesh.new()
    corners, faces = add_box(bm, (-0.5, -0.5, 0.0), (0.5, 0.5, 1.0))
    bmesh.ops.inset_individual(bm, faces=faces, thickness=0.08, depth=0.0, use_even_offset=True)
    bmesh.ops.inset_individual(bm, faces=faces, thickness=0.0, depth=-0.03, use_even_offset=True)
    bevel_weight = bm.edges.layers.float.new('bevel_weight_edge')
    corner_set = set(corners)
    for edge in bm.edges:
        if corner_set.issuperset(edge.verts):
            edge[bevel_weight] = 1.0
    lod0 = mesh_object('crate_LOD0', bm, [wood], root)
    bevel = lod0.modifiers.new('Bevel', 'BEVEL')
    bevel.limit_method = 'WEIGHT'
    bevel.width = 0.02
    bevel.segments = 1

    # LOD1: plain cube.
    bm = bmesh.new()
    add_box(bm, (-0.5, -0.5, 0.0), (0.5, 0.5, 1.0))
    lod1 = mesh_object('crate_LOD1', bm, [wood], root)

    # LOD2: the cube without its bottom face, which never shows on the ground.
    bm = bmesh.new()
    add_box(bm, (-0.5, -0.5, 0.0), (0.5, 0.5, 1.0), skip=('-z',))
    lod2 = mesh_object('crate_LOD2', bm, [wood], root)

    set_lod_distances([lod0, lod1, lod2], [0, 20, 60])
    box_collider(root, centre=(0.0, 0.0, 0.5), size=(1.0, 1.0, 1.0))


def build_vehicle():
    """2 m wide (outer wheel faces), 4 m long, 1.5 m tall, front at Blender -Y, wheels on the ground plane."""
    new_scene()
    paint = material('paint', (0.8, 0.8, 0.8), roughness=0.4)  # tinted at runtime by the game
    tyre = material('tyre', (0.02, 0.02, 0.02), roughness=0.9)
    root = empty('vehicle')
    PAINT, TYRE = 0, 1

    def sloped_nose(v):  # pull the top front edge of the body back 25 cm
        if v.y < 0 and v.z > 0.5:
            v.y += 0.25
        return v

    def tapered_cabin(v):  # narrower, shorter roof so the windscreen and rear window lean in
        if v.z > 1.2:
            v.x *= 0.85
            v.y = -0.8 if v.y < 0 else 0.1
        return v

    # LOD0: body, cabin set toward the front, four wheels (12 segments).
    bm = bmesh.new()
    add_box(bm, (-0.9, -2.0, 0.3), (0.9, 2.0, 0.95), PAINT, shape=sloped_nose)
    add_box(bm, (-0.8, -1.2, 0.95), (0.8, 0.3, 1.5), PAINT, shape=tapered_cabin)
    for x in (-0.875, 0.875):
        for y in (-1.3, 1.3):
            add_wheel(bm, Vector((x, y, 0.35)), radius=0.35, width=0.25, segments=12, mat=TYRE)
    lod0 = mesh_object('vehicle_LOD0', bm, [paint, tyre], root)

    # LOD1: body and cabin boxes.
    bm = bmesh.new()
    add_box(bm, (-0.9, -2.0, 0.1), (0.9, 2.0, 0.95), PAINT)
    add_box(bm, (-0.8, -1.2, 0.95), (0.8, 0.3, 1.5), PAINT)
    lod1 = mesh_object('vehicle_LOD1', bm, [paint], root)

    # LOD2: one box.
    bm = bmesh.new()
    add_box(bm, (-0.9, -2.0, 0.1), (0.9, 2.0, 1.3), PAINT)
    lod2 = mesh_object('vehicle_LOD2', bm, [paint], root)

    set_lod_distances([lod0, lod1, lod2], [0, 40, 120])
    box_collider(root, centre=(0.0, 0.0, 0.75), size=(2.0, 4.0, 1.5))

    # Chase-camera mount 14 m behind and 6 m up: glTF (0, 6, -14), the FollowCamera default offset
    # (docs/render.md 6.1). Pitched down so its forward axis aims at the roof line (0, 0, 1.5).
    socket(root, 'camera', (0.0, 14.0, 6.0), (math.atan2(6.0 - 1.5, 14.0), 0.0, 0.0))
    # Front bumper.
    socket(root, 'horn', (0.0, -2.0, 0.4))


def write(name, out_dir):
    glb = os.path.join(out_dir, f'{name}.glb')
    blend = os.path.join(out_dir, f'{name}.blend')
    bpy.ops.export_scene.gltf(filepath=glb, check_existing=False, **EXPORT_OPTIONS)
    # Saved after the export so the file keeps the remembered export settings.
    bpy.ops.wm.save_as_mainfile(filepath=blend, check_existing=False, compress=True)
    print(f'make-models: wrote {blend}')
    print(f'make-models: wrote {glb}')


def main():
    out_dir = os.path.abspath(parse_args().out)
    os.makedirs(out_dir, exist_ok=True)
    for name, build in (('crate', build_crate), ('vehicle', build_vehicle)):
        build()
        write(name, out_dir)


if __name__ == '__main__':
    main()

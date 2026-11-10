//! Rendering a surface on the GPU with surface.wgsl, and handing the result
//! to Vello as an image.
//!
//! Where a surface's pixels live:
//! - Small surfaces (at most `ATLAS_MAX_SLOT` px per side) get a slot in one
//!   shared atlas texture per device. All of a frame's dirty slots render in
//!   ONE pass (one draw per dirty rect, the surface picked by the instance
//!   index), and Vello registers and copies one image instead of one per
//!   surface. This is what makes hundreds of small surfaces cheap.
//! - Large surfaces (and small ones when the atlas is full) keep their own
//!   texture: there are few of them, and their cost is pixels, not passes.
//!
//! Vello copies every registered texture into its own image atlas on every
//! frame: anyrender_vello 0.15 `window_renderer.rs:463-465` marks each one
//! dirty, vello 0.11 `wgpu_engine.rs:486-504` copies it. That cannot be turned
//! off from here; the atlas reduces it to one copy (bounded by `ATLAS_SIZE`).
//!
//! Nothing is submitted here: passes are recorded into the frame encoder
//! (`frame`), atlas jobs are queued, and `frame::end_frame` submits.
use super::frame::{put_encoder, take_encoder};
use super::shape::{Look, Shape};
use super::tiles::{CULL_TILE, Tiles, dirty_rects};
use anyrender::{PaintScene, RenderContext, ResourceId, Scene};
use anyrender_vello::{DeviceHandle, wgpu};
use peniko::{
    Fill, ImageBrush, ImageSampler,
    kurbo::{Affine, Rect},
};
use std::{cell::RefCell, rc::Rc};

/// Lit edges move this fraction of the way to white at full facing; shadowed
/// edges lose this fraction of their brightness. Passed to the shader.
pub(super) const LIT_GAIN: f32 = 0.10;
pub(super) const SHADE_GAIN: f32 = 0.45;

/// vec4 slots before the shapes, per shape and per poly corner; the layout
/// is documented at the top of surface.wgsl.
const HEADER_SLOTS: usize = 7;
const SHAPE_SLOTS: usize = 4;
const CORNER_SLOTS: usize = 2;

/// Surfaces at most this big (device px, each side) live in the atlas.
const ATLAS_MAX_SLOT: u32 = 512;
/// Atlas edge, device px. Vello copies the whole atlas once per frame, so
/// this also bounds that copy (16 MiB). Holds about 726 slots of 72 px.
const ATLAS_SIZE: u32 = 2048;
/// Transparent gutter around each slot so bilinear sampling never bleeds.
const ATLAS_GUTTER: u32 = 2;

// ---------------------------------------------------------------- pipeline

/// Pipeline and bind group layout, one per device (not per surface).
struct Shared {
    pipeline: wgpu::RenderPipeline,
    layout: wgpu::BindGroupLayout,
}

thread_local! {
    static SHARED: RefCell<Vec<(wgpu::Device, Rc<Shared>)>> = const { RefCell::new(Vec::new()) };
    static ATLAS: RefCell<Vec<Atlas>> = const { RefCell::new(Vec::new()) };
}

fn shared(device: &wgpu::Device) -> Rc<Shared> {
    SHARED.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some((_, s)) = cache.iter().find(|(d, _)| d == device) {
            return s.clone();
        }
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("tk-surface"),
            source: wgpu::ShaderSource::Wgsl(include_str!("surface.wgsl").into()),
        });
        let storage = |binding| wgpu::BindGroupLayoutEntry {
            binding,
            visibility: wgpu::ShaderStages::FRAGMENT | wgpu::ShaderStages::VERTEX,
            ty: wgpu::BindingType::Buffer {
                ty: wgpu::BufferBindingType::Storage { read_only: true },
                has_dynamic_offset: false,
                min_binding_size: None,
            },
            count: None,
        };
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("tk-surface"),
            entries: &[storage(0), storage(1), storage(2)],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: Some("tk-surface"),
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("tk-surface"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs"),
                compilation_options: Default::default(),
                buffers: &[],
            },
            primitive: Default::default(),
            depth_stencil: None,
            multisample: Default::default(),
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs"),
                compilation_options: Default::default(),
                targets: &[Some(wgpu::ColorTargetState {
                    // Straight alpha, as Vello's registered textures expect.
                    format: wgpu::TextureFormat::Rgba8Unorm,
                    blend: None,
                    write_mask: wgpu::ColorWrites::ALL,
                })],
            }),
            multiview_mask: None,
            cache: None,
        });
        let s = Rc::new(Shared { pipeline, layout });
        cache.push((device.clone(), s.clone()));
        s
    })
}

fn texture(device: &wgpu::Device, width: u32, height: u32) -> wgpu::Texture {
    device.create_texture(&wgpu::TextureDescriptor {
        label: Some("tk-surface"),
        size: wgpu::Extent3d {
            width,
            height,
            depth_or_array_layers: 1,
        },
        mip_level_count: 1,
        sample_count: 1,
        dimension: wgpu::TextureDimension::D2,
        format: wgpu::TextureFormat::Rgba8Unorm,
        // COPY_SRC: Vello copies registered textures into its image atlas.
        usage: wgpu::TextureUsages::RENDER_ATTACHMENT
            | wgpu::TextureUsages::COPY_SRC
            | wgpu::TextureUsages::TEXTURE_BINDING,
        view_formats: &[],
    })
}

/// The three storage buffers one pass reads (parameters, tile lists, per-draw
/// job table) and their bind group; grown geometrically on demand.
struct Buffers {
    params: wgpu::Buffer,
    tiles: wgpu::Buffer,
    jobs: wgpu::Buffer,
    bind: wgpu::BindGroup,
}

impl Buffers {
    fn new(device: &wgpu::Device, shared: &Shared, sizes: [u64; 3]) -> Buffers {
        let buffer = |size: u64| {
            device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("tk-surface"),
                size: size.max(256),
                usage: wgpu::BufferUsages::STORAGE | wgpu::BufferUsages::COPY_DST,
                mapped_at_creation: false,
            })
        };
        let (params, tiles, jobs) = (buffer(sizes[0]), buffer(sizes[1]), buffer(sizes[2]));
        fn entry(binding: u32, buffer: &wgpu::Buffer) -> wgpu::BindGroupEntry<'_> {
            wgpu::BindGroupEntry {
                binding,
                resource: buffer.as_entire_binding(),
            }
        }
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("tk-surface"),
            layout: &shared.layout,
            entries: &[entry(0, &params), entry(1, &tiles), entry(2, &jobs)],
        });
        Buffers {
            params,
            tiles,
            jobs,
            bind,
        }
    }

    fn upload(&mut self, gpu: (&wgpu::Device, &wgpu::Queue, &Shared), data: [&[u8]; 3]) {
        let (device, queue, shared) = gpu;
        let have = [self.params.size(), self.tiles.size(), self.jobs.size()];
        if data.iter().zip(have).any(|(d, h)| d.len() as u64 > h) {
            let sizes =
                std::array::from_fn(|i| (data[i].len() as u64).next_power_of_two().max(have[i]));
            *self = Buffers::new(device, shared, sizes);
        }
        for (buffer, bytes) in [&self.params, &self.tiles, &self.jobs]
            .into_iter()
            .zip(data)
        {
            if !bytes.is_empty() {
                queue.write_buffer(buffer, 0, bytes);
            }
        }
    }
}

fn floats(v: &[[f32; 4]]) -> Vec<u8> {
    v.iter().flatten().flat_map(|f| f.to_ne_bytes()).collect()
}

fn words(v: &[u32]) -> Vec<u8> {
    v.iter().flat_map(|w| w.to_ne_bytes()).collect()
}

/// One surface's shader input, relative to its own target: parameter slots
/// and tile words (tile starts relative to its own words). A job record
/// supplies the absolute bases when several surfaces share a pass.
struct Encoded {
    params: Vec<[f32; 4]>,
    words: Vec<u32>,
}

fn encode(shapes: &[Shape], look: &Look, width: u32, height: u32, scale: f32) -> Encoded {
    let tiles = Tiles::build(shapes, look, width, height, scale);
    let corners: usize = shapes
        .iter()
        .map(|s| s.poly.as_ref().map_or(0, |p| p.corners.len()))
        .sum();
    let light = look.light();
    let (outer, inner) = look.border_edges();
    let mut params =
        vec![[0f32; 4]; HEADER_SLOTS + SHAPE_SLOTS * shapes.len() + CORNER_SLOTS * corners];
    params[0] = [width as f32, height as f32, scale, shapes.len() as f32];
    params[1] = [look.bevel * scale, light[0], light[1], look.sign()];
    params[2] = [look.join, LIT_GAIN, SHADE_GAIN, look.gap];
    params[3] = look.fill;
    params[4] = [
        outer,
        inner,
        if look.border_lit { 1.0 } else { 0.0 },
        if look.border > 0.0 { 1.0 } else { 0.0 },
    ];
    params[5] = look.border_colour;
    params[6] = [tiles.nx as f32, CULL_TILE as f32, 0.0, 0.0];
    let mut corner_slot = HEADER_SLOTS + SHAPE_SLOTS * shapes.len();
    for (i, s) in shapes.iter().enumerate() {
        let base = HEADER_SLOTS + i * SHAPE_SLOTS;
        params[base] = s.rect;
        params[base + 1] = s.radii;
        let kind = if s.poly.is_some() { 1.0 } else { 0.0 };
        params[base + 2] = [if s.sub { 1.0 } else { 0.0 }, s.join, s.gap, kind];
        if let Some(poly) = &s.poly {
            params[base + 3] = [
                corner_slot as f32,
                poly.corners.len() as f32,
                poly.orient,
                0.0,
            ];
            for k in &poly.corners {
                params[corner_slot] = [k.c[0], k.c[1], k.r, if k.convex { 1.0 } else { 0.0 }];
                params[corner_slot + 1] = [k.t1[0], k.t1[1], k.t2[0], k.t2[1]];
                corner_slot += CORNER_SLOTS;
            }
        }
    }
    let header = (tiles.ranges.len() * 2) as u32;
    let mut words = Vec::with_capacity(tiles.ranges.len() * 2 + tiles.indices.len());
    for [start, n] in &tiles.ranges {
        words.push(header + start);
        words.push(*n);
    }
    words.extend_from_slice(&tiles.indices);
    Encoded { params, words }
}

// ---------------------------------------------------------------- atlas

/// A slot (device px) in a device's atlas, valid for one atlas generation.
#[derive(Clone, Copy, PartialEq)]
struct Slot {
    generation: u64,
    x: u32,
    y: u32,
}

struct AtlasJob {
    origin: [u32; 2],
    encoded: Encoded,
    /// Slot-local rects to render; the whole slot for a full render.
    rects: Vec<[u32; 4]>,
}

struct Atlas {
    device: wgpu::Device,
    queue: wgpu::Queue,
    shared: Rc<Shared>,
    texture: wgpu::Texture,
    view: wgpu::TextureView,
    /// Bumped when the atlas is repacked; slots of older generations are void.
    generation: u64,
    /// Registered resource id and the surface whose (Blitz proxy) render
    /// context registered it: Blitz unregisters it when that surface's node is
    /// dropped, so the owner's drop clears this and the next surface re-registers.
    id: Option<(ResourceId, u32)>,
    shelf_x: u32,
    shelf_y: u32,
    shelf_h: u32,
    /// Slots released since the last repack (space a repack would recover).
    dead: u64,
    /// Clear before the next pass (after a repack, stale slots must go).
    clear: bool,
    jobs: Vec<AtlasJob>,
    buffers: Buffers,
}

impl Atlas {
    fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Atlas {
        let shared = shared(device);
        let texture = texture(device, ATLAS_SIZE, ATLAS_SIZE);
        let view = texture.create_view(&Default::default());
        let buffers = Buffers::new(device, &shared, [4096, 4096, 256]);
        Atlas {
            device: device.clone(),
            queue: queue.clone(),
            shared,
            texture,
            view,
            generation: 1,
            id: None,
            shelf_x: 0,
            shelf_y: 0,
            shelf_h: 0,
            dead: 0,
            clear: true,
            jobs: Vec::new(),
            buffers,
        }
    }

    /// Shelf allocation. When full and slots have been released, repack:
    /// start a new generation, and every atlas surface re-allocates and
    /// re-renders on its next paint (the same frame, since Blitz paints every
    /// widget each frame).
    fn alloc(&mut self, width: u32, height: u32) -> Option<Slot> {
        let (w, h) = (width + 2 * ATLAS_GUTTER, height + 2 * ATLAS_GUTTER);
        if self.shelf_x + w > ATLAS_SIZE {
            self.shelf_x = 0;
            self.shelf_y += self.shelf_h;
            self.shelf_h = 0;
        }
        if self.shelf_y + h > ATLAS_SIZE {
            if self.dead > 0 {
                self.generation += 1;
                (self.shelf_x, self.shelf_y, self.shelf_h, self.dead) = (0, 0, 0, 0);
                self.jobs.clear();
                self.clear = true;
                return self.alloc(width, height);
            }
            return None;
        }
        let slot = Slot {
            generation: self.generation,
            x: self.shelf_x + ATLAS_GUTTER,
            y: self.shelf_y + ATLAS_GUTTER,
        };
        self.shelf_x += w;
        self.shelf_h = self.shelf_h.max(h);
        Some(slot)
    }

    fn release(&mut self, owner: u32) {
        self.dead += 1;
        if self.id.is_some_and(|(_, o)| o == owner) {
            self.id = None;
        }
    }

    /// One pass for every queued job: concatenate their inputs, write a job
    /// table (params base, tile words base, slot origin) and draw each dirty
    /// rect with the job's index as the instance.
    fn encode(&mut self, encoder: &mut wgpu::CommandEncoder) {
        let mut params: Vec<[f32; 4]> = Vec::new();
        let mut tile_words: Vec<u32> = Vec::new();
        let mut table: Vec<u32> = Vec::new();
        for job in &self.jobs {
            table.extend([
                params.len() as u32,
                tile_words.len() as u32,
                job.origin[0],
                job.origin[1],
            ]);
            params.extend_from_slice(&job.encoded.params);
            tile_words.extend_from_slice(&job.encoded.words);
        }
        let data = [floats(&params), words(&tile_words), words(&table)];
        self.buffers.upload(
            (&self.device, &self.queue, &self.shared),
            [&data[0], &data[1], &data[2]],
        );
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("tk-surface atlas"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: &self.view,
                depth_slice: None,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: if self.clear {
                        wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
                    } else {
                        wgpu::LoadOp::Load
                    },
                    store: wgpu::StoreOp::Store,
                },
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.shared.pipeline);
        pass.set_bind_group(0, &self.buffers.bind, &[]);
        for (i, job) in self.jobs.iter().enumerate() {
            for &[x, y, w, h] in &job.rects {
                pass.set_scissor_rect(job.origin[0] + x, job.origin[1] + y, w, h);
                pass.draw(0..3, i as u32..i as u32 + 1);
            }
        }
        drop(pass);
        self.jobs.clear();
        self.clear = false;
    }
}

/// Run `f` on this device's atlas, creating it on first use.
fn with_atlas<R>(device: &wgpu::Device, queue: &wgpu::Queue, f: impl FnOnce(&mut Atlas) -> R) -> R {
    ATLAS.with(|atlases| {
        let mut atlases = atlases.borrow_mut();
        let i = match atlases.iter().position(|a| a.device == *device) {
            Some(i) => i,
            None => {
                atlases.push(Atlas::new(device, queue));
                atlases.len() - 1
            }
        };
        f(&mut atlases[i])
    })
}

/// Called by `frame::end_frame`: record each atlas's pass into its device's
/// frame encoder.
pub(super) fn encode_atlases() {
    ATLAS.with(|atlases| {
        for atlas in atlases.borrow_mut().iter_mut() {
            if !atlas.jobs.is_empty() {
                let mut encoder = take_encoder(&atlas.device);
                atlas.encode(&mut encoder);
                put_encoder(&atlas.device, &atlas.queue, encoder);
            }
        }
    });
}

/// Called on renderer suspend: the registered atlas textures are gone.
pub(super) fn forget_atlases() {
    ATLAS.with(|a| a.borrow_mut().clear());
}

// ---------------------------------------------------------------- surface

/// What the target currently shows.
struct Rendered {
    shapes: Vec<Shape>,
    look: Look,
    scale: u32,
}

enum Target {
    None,
    /// Its own registered texture, with its own buffers.
    Own(wgpu::Texture, ResourceId, Box<Buffers>),
    /// A slot in the device atlas, and the slot's size.
    Slot(Slot, u32, u32),
}

/// A surface's GPU state: where its pixels live and what they show.
pub(super) struct Gpu {
    owner: u32,
    device: wgpu::Device,
    queue: wgpu::Queue,
    shared: Rc<Shared>,
    target: Target,
    rendered: Option<Rendered>,
    /// Atlas resource id to draw with (atlas surfaces only).
    atlas_id: Option<ResourceId>,
    /// The atlas had no room at this size: keep the own texture instead of
    /// retrying (and fully re-rendering) every frame.
    atlas_full: bool,
}

impl Drop for Gpu {
    fn drop(&mut self) {
        if let Target::Slot(..) = self.target {
            let (owner, device) = (self.owner, &self.device);
            let _ = ATLAS.try_with(|atlases| {
                if let Some(atlas) = atlases
                    .borrow_mut()
                    .iter_mut()
                    .find(|a| a.device == *device)
                {
                    atlas.release(owner);
                }
            });
        }
    }
}

impl Gpu {
    /// None if the render context is not the wgpu/Vello renderer.
    pub fn new(render_ctx: &mut dyn RenderContext, owner: u32) -> Option<Self> {
        let handle = render_ctx
            .renderer_specific_context()?
            .downcast::<DeviceHandle>()
            .ok()?;
        let device = handle.device.clone();
        let shared = shared(&device);
        Some(Self {
            owner,
            queue: handle.queue.clone(),
            device,
            shared,
            target: Target::None,
            rendered: None,
            atlas_id: None,
            atlas_full: false,
        })
    }

    fn slot_current(&self, slot: &Slot) -> bool {
        with_atlas(&self.device, &self.queue, |a| {
            a.generation == slot.generation
        })
    }

    /// Make sure the target exists, fits and is current. False if unavailable.
    fn ensure_target(
        &mut self,
        render_ctx: &mut dyn RenderContext,
        width: u32,
        height: u32,
    ) -> bool {
        let small = width <= ATLAS_MAX_SLOT && height <= ATLAS_MAX_SLOT;
        let fits = match &self.target {
            Target::Own(t, _, _) => {
                let same = t.width() == width && t.height() == height;
                if !same {
                    self.atlas_full = false;
                }
                same && (!small || self.atlas_full)
            }
            Target::Slot(slot, w, h) => *w == width && *h == height && self.slot_current(slot),
            Target::None => false,
        };
        if fits {
            return true;
        }
        // Release the old target. A slot from an older generation was
        // already reclaimed by the repack.
        match std::mem::replace(&mut self.target, Target::None) {
            Target::Own(_, id, _) => render_ctx.unregister_resource(id),
            Target::Slot(slot, ..) if self.slot_current(&slot) => {
                let owner = self.owner;
                with_atlas(&self.device, &self.queue, |a| a.release(owner));
            }
            _ => {}
        }
        self.rendered = None;
        if small
            && let Some(slot) = with_atlas(&self.device, &self.queue, |a| a.alloc(width, height))
        {
            self.target = Target::Slot(slot, width, height);
            return true;
        }
        self.atlas_full = small;
        let texture = texture(&self.device, width, height);
        match render_ctx.try_register_custom_resource(Box::new(texture.clone())) {
            Ok(id) => {
                let buffers = Buffers::new(&self.device, &self.shared, [1024, 1024, 256]);
                self.target = Target::Own(texture, id, Box::new(buffers));
                true
            }
            Err(error) => {
                eprintln!("tk-surface: texture registration failed: {error:?}");
                false
            }
        }
    }

    /// Bring the target up to date with `shapes` under `look`: nothing if it
    /// already shows them, the dirty rects if only some shapes changed, all
    /// of it otherwise. Returns the device pixels queued for re-rendering.
    pub fn update(
        &mut self,
        render_ctx: &mut dyn RenderContext,
        shapes: &[Shape],
        look: &Look,
        width: u32,
        height: u32,
        scale: f32,
    ) -> u64 {
        if !self.ensure_target(render_ctx, width, height) {
            return 0;
        }
        if let Target::Slot(..) = self.target {
            // The atlas texture is registered once, through whichever atlas
            // surface paints first after it was created or its owner dropped.
            let owner = self.owner;
            self.atlas_id = with_atlas(&self.device, &self.queue, |atlas| {
                if atlas.id.is_none() {
                    match render_ctx.try_register_custom_resource(Box::new(atlas.texture.clone())) {
                        Ok(id) => atlas.id = Some((id, owner)),
                        Err(error) => {
                            eprintln!("tk-surface: atlas registration failed: {error:?}")
                        }
                    }
                }
                atlas.id.map(|(id, _)| id)
            });
        }
        let rects = match &self.rendered {
            Some(r) if r.look == *look && r.scale == scale.to_bits() => {
                if r.shapes == shapes {
                    return 0;
                }
                dirty_rects(&r.shapes, shapes, look, width, height, scale)
            }
            _ => None,
        };
        let partial = rects.is_some();
        let rects = rects.unwrap_or_else(|| vec![[0, 0, width, height]]);
        let pixels: u64 = rects.iter().map(|r| r[2] as u64 * r[3] as u64).sum();
        let encoded = encode(shapes, look, width, height, scale);
        match &mut self.target {
            Target::Slot(slot, ..) => {
                let job = AtlasJob {
                    origin: [slot.x, slot.y],
                    encoded,
                    rects,
                };
                with_atlas(&self.device, &self.queue, |atlas| atlas.jobs.push(job));
            }
            Target::Own(texture, _, buffers) => {
                buffers.upload(
                    (&self.device, &self.queue, &self.shared),
                    [
                        &floats(&encoded.params),
                        &words(&encoded.words),
                        &words(&[0, 0, 0, 0]),
                    ],
                );
                let view = texture.create_view(&Default::default());
                let mut encoder = take_encoder(&self.device);
                {
                    let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                        label: Some("tk-surface"),
                        color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                            view: &view,
                            depth_slice: None,
                            resolve_target: None,
                            ops: wgpu::Operations {
                                // A partial render keeps every pixel outside its rects.
                                load: if partial {
                                    wgpu::LoadOp::Load
                                } else {
                                    wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT)
                                },
                                store: wgpu::StoreOp::Store,
                            },
                        })],
                        depth_stencil_attachment: None,
                        timestamp_writes: None,
                        occlusion_query_set: None,
                        multiview_mask: None,
                    });
                    pass.set_pipeline(&self.shared.pipeline);
                    pass.set_bind_group(0, &buffers.bind, &[]);
                    for &[x, y, w, h] in &rects {
                        pass.set_scissor_rect(x, y, w, h);
                        pass.draw(0..3, 0..1);
                    }
                }
                put_encoder(&self.device, &self.queue, encoder);
            }
            Target::None => return 0,
        }
        self.rendered = Some(Rendered {
            shapes: shapes.to_vec(),
            look: *look,
            scale: scale.to_bits(),
        });
        pixels
    }

    /// The Scene that draws the target at the widget's content box.
    pub fn scene(&self, width: u32, height: u32) -> Scene {
        let mut scene = Scene::new();
        let (id, offset) = match &self.target {
            Target::Own(_, id, _) => (*id, None),
            Target::Slot(slot, ..) => match self.atlas_id {
                // Sample the atlas at the slot: brush moved by -origin.
                Some(id) => (
                    id,
                    Some(Affine::translate((-(slot.x as f64), -(slot.y as f64)))),
                ),
                None => return scene,
            },
            Target::None => return scene,
        };
        let paint: anyrender::PaintRef<'_> = anyrender::Paint::Resource(ImageBrush {
            image: id,
            sampler: ImageSampler::new(),
        });
        scene.fill(
            Fill::NonZero,
            Affine::IDENTITY,
            paint,
            offset,
            &Rect::new(0.0, 0.0, width as f64, height as f64),
        );
        scene
    }
}

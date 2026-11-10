//! The per-frame hook. Surfaces never submit GPU work themselves: during
//! `paint` they only record (into one command encoder per device, and into
//! the device's atlas job list). `end_frame` then renders all atlas jobs in
//! one pass and submits once per device.
//!
//! Why: measured on the lab stress test (200 small surfaces moving, release),
//! one encoder + `queue.submit` per surface cost ~16 us of submit each, and
//! batching those per-surface render passes into one submit did not help
//! either: the cost is per render pass, i.e. per target texture. One pass
//! into a shared atlas is what removes it (see `gpu`).
//!
//! `end_frame` must run after Blitz has painted every widget and before Vello
//! renders, so that Vello's copy of the textures sees this frame's contents.
//! `FrameRenderer` does that for the window. An embedder that paints a
//! document some other way (the offscreen tests) must call `end_frame` itself
//! after `paint_scene`, or surfaces never appear.
use super::gpu;
use anyrender::{RenderContext, ResourceId, WindowHandle, WindowRenderer};
use anyrender_vello::{DeviceHandle, VelloScenePainter, VelloWindowRenderer, wgpu};
use std::{cell::RefCell, sync::Arc};

thread_local! {
    /// One open command encoder per device for the frame being painted.
    static BATCH: RefCell<Vec<(wgpu::Device, wgpu::Queue, wgpu::CommandEncoder)>> =
        const { RefCell::new(Vec::new()) };
}

/// Take this device's frame encoder (or start one) to record a pass.
pub(super) fn take_encoder(device: &wgpu::Device) -> wgpu::CommandEncoder {
    BATCH
        .with(|b| {
            let mut b = b.borrow_mut();
            b.iter()
                .position(|(d, _, _)| d == device)
                .map(|i| b.swap_remove(i).2)
        })
        .unwrap_or_else(|| {
            device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("tk-surface frame"),
            })
        })
}

/// Give the encoder back so later surfaces (and `end_frame`) append to it.
pub(super) fn put_encoder(
    device: &wgpu::Device,
    queue: &wgpu::Queue,
    encoder: wgpu::CommandEncoder,
) {
    BATCH.with(|b| {
        b.borrow_mut()
            .push((device.clone(), queue.clone(), encoder))
    });
}

/// Render the frame's atlas jobs and submit everything recorded this frame,
/// once per device. See the module header for when to call it.
pub fn end_frame() {
    gpu::encode_atlases();
    let pending = BATCH.with(|b| std::mem::take(&mut *b.borrow_mut()));
    for (_, queue, encoder) in pending {
        queue.submit([encoder.finish()]);
    }
}

/// `VelloWindowRenderer` plus `end_frame` after each frame's paint.
/// Everything else is delegated unchanged.
pub(crate) struct FrameRenderer(pub VelloWindowRenderer);

impl FrameRenderer {
    pub fn current_device_handle(&self) -> Option<&DeviceHandle> {
        self.0.current_device_handle()
    }
}

impl RenderContext for FrameRenderer {
    fn try_register_custom_resource(
        &mut self,
        resource: Box<dyn std::any::Any>,
    ) -> Result<ResourceId, anyrender::RegisterResourceError> {
        self.0.try_register_custom_resource(resource)
    }

    fn unregister_resource(&mut self, resource_id: ResourceId) {
        self.0.unregister_resource(resource_id);
    }

    fn renderer_specific_context(&self) -> Option<Box<dyn std::any::Any>> {
        self.0.renderer_specific_context()
    }
}

impl WindowRenderer for FrameRenderer {
    type ScenePainter<'a>
        = VelloScenePainter<'a, 'a>
    where
        Self: 'a;

    fn resume<F: FnOnce() + 'static>(
        &mut self,
        window: Arc<dyn WindowHandle>,
        width: u32,
        height: u32,
        on_ready: F,
    ) {
        self.0.resume(window, width, height, on_ready);
    }

    fn complete_resume(&mut self) -> bool {
        self.0.complete_resume()
    }

    fn suspend(&mut self) {
        // The renderer drops every registered texture on suspend. Forget the
        // atlases and anything recorded; surfaces re-create on resume.
        BATCH.with(|b| b.borrow_mut().clear());
        gpu::forget_atlases();
        self.0.suspend();
    }

    fn is_active(&self) -> bool {
        self.0.is_active()
    }

    fn is_pending(&self) -> bool {
        self.0.is_pending()
    }

    fn set_size(&mut self, width: u32, height: u32) {
        self.0.set_size(width, height);
    }

    fn render<F: FnOnce(&mut Self::ScenePainter<'_>)>(&mut self, draw_fn: F) {
        self.0.render(|painter| {
            draw_fn(painter);
            end_frame();
        });
    }
}

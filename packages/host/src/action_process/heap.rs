use std::{cell::Cell, mem::align_of, ptr, rc::Rc};

use rquickjs::allocator::{Allocator, RustAllocator};

pub(super) const OUT_OF_MEMORY: &str = "Server action ran out of memory";

pub(super) struct Heap {
    limit: usize,
    used: usize,
    exhausted: Rc<Cell<bool>>,
}

impl Heap {
    pub fn new(limit: usize, exhausted: Rc<Cell<bool>>) -> Self {
        Self {
            limit,
            used: 0,
            exhausted,
        }
    }

    fn allocate(
        &mut self,
        old: usize,
        size: Option<usize>,
        allocate: impl FnOnce(&mut RustAllocator) -> *mut u8,
    ) -> *mut u8 {
        let remaining = self.limit - (self.used - old);
        // RustAllocator rounds each request up to its alignment.
        let alignment = align_of::<u64>();
        let fits = size.is_some_and(|size| size <= remaining - remaining % alignment);
        if fits {
            let output = allocate(&mut RustAllocator);
            if !output.is_null() {
                // SAFETY: output is a live RustAllocator allocation.
                self.used = self.used - old + unsafe { Self::usable_size(output) };
                return output;
            }
        }
        self.exhausted.set(true);
        ptr::null_mut()
    }
}

// SAFETY: All live allocations and size lookups are delegated to RustAllocator.
// Rejecting a request before reallocating leaves the original allocation intact.
unsafe impl Allocator for Heap {
    fn alloc(&mut self, size: usize) -> *mut u8 {
        self.allocate(0, Some(size), |allocator| allocator.alloc(size))
    }

    fn calloc(&mut self, count: usize, size: usize) -> *mut u8 {
        self.allocate(0, count.checked_mul(size), |allocator| {
            allocator.calloc(count, size)
        })
    }

    unsafe fn dealloc(&mut self, ptr: *mut u8) {
        // SAFETY: QuickJS returns the same live allocation we delegated.
        self.used -= unsafe { Self::usable_size(ptr) };
        unsafe { RustAllocator.dealloc(ptr) };
    }

    unsafe fn realloc(&mut self, ptr: *mut u8, new_size: usize) -> *mut u8 {
        if ptr.is_null() {
            return self.alloc(new_size);
        }
        if new_size == 0 {
            // SAFETY: QuickJS passed a live allocation to realloc.
            unsafe { self.dealloc(ptr) };
            return ptr::null_mut();
        }

        // SAFETY: ptr is a live allocation from RustAllocator.
        let old = unsafe { Self::usable_size(ptr) };
        self.allocate(old, Some(new_size), |allocator| unsafe {
            allocator.realloc(ptr, new_size)
        })
    }

    unsafe fn usable_size(ptr: *mut u8) -> usize {
        // SAFETY: The allocation was created by RustAllocator.
        unsafe { RustAllocator::usable_size(ptr) }
    }
}

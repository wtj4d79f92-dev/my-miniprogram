Component({
  options: {
    styleIsolation: 'apply-shared',
  },
  properties: {
    url: { type: String, value: '' },
    color: { type: String, value: '#4ECDC4' },
    text: { type: String, value: '友' },
    size: { type: String, value: 'md' },
    ring: { type: Boolean, value: false },
  },
})

import React, { useState, useEffect } from "react";
import {
    Mail,
    Lock,
    Eye,
    EyeOff,
    CheckCircle,
    X,
    Rocket,
    Sparkles,
    Trophy,
    UserPlus,
    AlertCircle
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { motion, AnimatePresence } from "framer-motion";
import { useAlert } from '../components/Alert';

const Login = ({ setUser }) => {
    const navigate = useNavigate();
    const { showAlert, AlertComponent } = useAlert();

    // State management
    const [formData, setFormData] = useState({
        email: '',
        password: ''
    });
    const [showPassword, setShowPassword] = useState(false);
    const [errors, setErrors] = useState({});
    const [isLoading, setIsLoading] = useState(false);
    const [serverError, setServerError] = useState('');
    const [showSuccessPopup, setShowSuccessPopup] = useState(false);
    const [userData, setUserData] = useState(null);
    const [failedAttempts, setFailedAttempts] = useState(0);

    // Check for existing session on mount
    useEffect(() => {
        const savedUser = localStorage.getItem('user');
        const savedIsLogin = localStorage.getItem('isLogin');

        if (savedUser && savedIsLogin === 'true') {
            try {
                const userData = JSON.parse(savedUser);
                setUser({
                    isLogin: true,
                    role: userData.role,
                    name: userData.name,
                    id: userData.id
                });
                // Redirect based on role
                if (userData.role === "admin") {
                    navigate("/admin");
                } else if (userData.role === "student") {
                    navigate(`/studentprofile/${userData.id}`);
                }
            } catch (error) {
                console.error('Error parsing user data:', error);
                localStorage.removeItem('user');
                localStorage.removeItem('isLogin');
            }
        }
    }, [navigate, setUser]);

    // Handle input change
    const handleChange = (e) => {
        const { name, value } = e.target;
        setFormData(prev => ({
            ...prev,
            [name]: value
        }));
        if (errors[name]) {
            setErrors(prev => ({ ...prev, [name]: '' }));
        }
        if (serverError) setServerError('');
    };

    // Validate form
    const validateForm = () => {
        const newErrors = {};

        if (!formData.email) {
            newErrors.email = 'Email is required';
            showAlert('Please enter your email address', 'warning', 3000);
        } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(formData.email)) {
            newErrors.email = 'Please enter a valid email address';
            showAlert('Please enter a valid email address', 'error', 3000);
        }

        if (!formData.password) {
            newErrors.password = 'Password is required';
            showAlert('Please enter your password', 'warning', 3000);
        } else if (formData.password.length < 6) {
            newErrors.password = 'Password must be at least 6 characters';
            showAlert('Password must be at least 6 characters long', 'error', 3000);
        }

        setErrors(newErrors);
        return Object.keys(newErrors).length === 0;
    };

    // Handle forgot password click -> go to OTP reset flow
    const handleForgotPassword = () => {
        navigate('/forgot-password');
    };

    // Handle form submission
    const handleSubmit = async (e) => {
        e.preventDefault();

        if (!validateForm()) return;

        setIsLoading(true);
        setServerError('');

        try {
            const response = await axios.post(
                `${import.meta.env.VITE_BACKEND_URL}/login`,
                {
                    email: formData.email.trim(),
                    password: formData.password
                }
            );

            if (response.data.success) {
                // Reset failed attempts on successful login
                setFailedAttempts(0);
                
                const { token, user } = response.data;

                // Store token and user data
                if (token) {
                    localStorage.setItem('token', token);
                }
                if (user) {
                    localStorage.setItem('user', JSON.stringify(user));
                    localStorage.setItem('isLogin', 'true');

                    // Update user state
                    setUser({
                        isLogin: true,
                        role: user.role,
                        name: user.name,
                        id: user.id
                    });

                    // Prepare user data for popup
                    setUserData({
                        ...user,
                        loginTime: new Date().toLocaleTimeString(),
                        loginDate: new Date().toLocaleDateString()
                    });

                    // Show success popup
                    setShowSuccessPopup(true);

                    // Auto redirect after 2 seconds
                    setTimeout(() => {
                        setShowSuccessPopup(false);
                        if (user.role === "admin") {
                            navigate("/admin");
                        } else if (user.role === "student") {
                            navigate(`/studentprofile/${user.id}`);
                        }
                    }, 2000);
                }
            } else {
                const errorMsg = response.data.message || 'Login failed';
                setServerError(errorMsg);
                
                // Increment failed attempts
                const newAttempts = failedAttempts + 1;
                setFailedAttempts(newAttempts);
                
                // Show error alert
                showAlert(errorMsg, 'error', 4000);
                
                // Suggest password reset after 2 failed attempts
                if (newAttempts >= 2) {
                    setTimeout(() => {
                        showAlert(
                            '🔑 Forgot your password? Click "Forgot Password?" below to reset it with an OTP sent to your email.',
                            'info',
                            5000,
                            'Password Help'
                        );
                    }, 500);
                }
            }
        } catch (error) {
            console.error('Login Error:', error);

            let errorMessage = 'Something went wrong. Please try again.';

            if (error.response) {
                errorMessage = error.response.data.message || errorMessage;
                
                // Increment failed attempts
                const newAttempts = failedAttempts + 1;
                setFailedAttempts(newAttempts);
                
                // Specific error handling based on status
                if (error.response.status === 401) {
                    showAlert('Invalid email or password. Please try again.', 'error', 4000);
                    
                    // Suggest password reset after 2 failed attempts
                    if (newAttempts >= 2) {
                        setTimeout(() => {
                            showAlert(
                                '🔑 Forgot your password? Click "Forgot Password?" below to reset it with an OTP sent to your email.',
                                'info',
                                5000,
                                'Password Help'
                            );
                        }, 500);
                    }
                } else if (error.response.status === 403) {
                    showAlert('Account is deactivated. Please contact admin.', 'error', 4000);
                } else {
                    showAlert(errorMessage, 'error', 4000);
                }
            } else if (error.request) {
                errorMessage = 'Cannot connect to server. Please check your connection.';
                showAlert(errorMessage, 'error', 4000);
            } else {
                showAlert(errorMessage, 'error', 4000);
            }

            setServerError(errorMessage);
        } finally {
            setIsLoading(false);
        }
    };

    // Handle close popup
    const handleClosePopup = () => {
        setShowSuccessPopup(false);
        showAlert('Redirecting to dashboard...', 'info', 2000);
        setTimeout(() => {
            if (userData) {
                if (userData.role === "admin") {
                    navigate("/admin");
                } else if (userData.role === "student") {
                    navigate(`/studentprofile/${userData.id}`);
                }
            }
        }, 500);
    };

    // Handle go to dashboard
    const handleGoToDashboard = () => {
        setShowSuccessPopup(false);
        showAlert('Redirecting to dashboard...', 'info', 2000);
        setTimeout(() => {
            if (userData) {
                if (userData.role === "admin") {
                    navigate("/admin");
                } else if (userData.role === "student") {
                    navigate(`/studentprofile/${userData.id}`);
                }
            }
        }, 500);
    };

    return (
        <div className="min-h-screen w-full bg-gradient-to-br from-sky-50 via-blue-50 to-indigo-50 flex items-center justify-center p-4">
            {AlertComponent}

            <motion.div
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.4 }}
                className="w-full max-w-md"
            >
                <div className="bg-white backdrop-blur-sm rounded-2xl shadow-2xl p-8 border border-white/20">
                    {/* Header */}
                    <div className="text-center mb-6">
                        <motion.div
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: "spring", stiffness: 200 }}
                            className="inline-flex items-center justify-center w-16 h-16 bg-gradient-to-br from-blue-600 to-indigo-600 rounded-2xl shadow-lg mb-4"
                        >
                            <svg
                                className="w-8 h-8 text-white"
                                fill="none"
                                stroke="currentColor"
                                viewBox="0 0 24 24"
                            >
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 14l9-5-9-5-9 5 9 5z"
                                />
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 14l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14z"
                                />
                                <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 14l9-5-9-5-9 5 9 5zm0 0l6.16-3.422a12.083 12.083 0 01.665 6.479A11.952 11.952 0 0012 20.055a11.952 11.952 0 00-6.824-2.998 12.078 12.078 0 01.665-6.479L12 14zm-4 6v-7.5l4-2.222"
                                />
                            </svg>
                        </motion.div>
                        <h1 className="text-3xl font-bold text-gray-800 mb-2">Welcome Back</h1>
                        <p className="text-gray-500">Sign in to your account</p>
                    </div>

                    {/* Failed Attempts Indicator */}
                    {failedAttempts > 0 && (
                        <motion.div
                            initial={{ opacity: 0, y: -10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="mb-4 p-3 bg-yellow-50 border border-yellow-200 rounded-lg"
                        >
                            <div className="flex items-start gap-2">
                                <AlertCircle className="w-5 h-5 text-yellow-600 flex-shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-sm text-yellow-800">
                                        <span className="font-semibold">{failedAttempts}</span> failed login attempt{failedAttempts > 1 ? 's' : ''}
                                    </p>
                                    {failedAttempts >= 2 && (
                                        <button
                                            type="button"
                                            onClick={handleForgotPassword}
                                            className="text-xs text-blue-600 hover:text-blue-700 hover:underline font-medium mt-1"
                                        >
                                            Reset it using OTP →
                                        </button>
                                    )}
                                </div>
                            </div>
                        </motion.div>
                    )}

                    {/* Server Error */}
                    <AnimatePresence>
                        {serverError && (
                            <motion.div
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                exit={{ opacity: 0, y: -10 }}
                                className="mb-4 p-3 bg-red-50 border border-red-200 rounded-lg flex items-center gap-2 text-red-600 text-sm"
                            >
                                <svg className="w-4 h-4 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                                    <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                                </svg>
                                <span>{serverError}</span>
                            </motion.div>
                        )}
                    </AnimatePresence>

                    {/* Form */}
                    <form onSubmit={handleSubmit} className="space-y-4">
                        {/* Email */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Email Address *
                            </label>
                            <div className="relative">
                                <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                <input
                                    type="email"
                                    name="email"
                                    value={formData.email}
                                    onChange={handleChange}
                                    placeholder="Enter your email"
                                    className={`w-full pl-10 pr-4 py-2.5 border rounded-xl focus:outline-none focus:ring-2 ${errors.email
                                        ? 'border-red-400 focus:ring-red-400'
                                        : 'border-gray-300 focus:ring-blue-500'
                                        }`}
                                />
                            </div>
                            {errors.email && (
                                <p className="mt-1 text-xs text-red-500">{errors.email}</p>
                            )}
                        </div>

                        {/* Password */}
                        <div>
                            <label className="block text-sm font-medium text-gray-700 mb-1">
                                Password *
                            </label>
                            <div className="relative">
                                <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400" />
                                <input
                                    type={showPassword ? 'text' : 'password'}
                                    name="password"
                                    value={formData.password}
                                    onChange={handleChange}
                                    placeholder="Enter your password"
                                    className={`w-full pl-10 pr-12 py-2.5 border rounded-xl focus:outline-none focus:ring-2 ${errors.password
                                        ? 'border-red-400'
                                        : 'border-gray-300 focus:ring-blue-500'
                                        }`}
                                />
                                <button
                                    type="button"
                                    onClick={() => setShowPassword(!showPassword)}
                                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                                >
                                    {showPassword ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                                </button>
                            </div>
                            {errors.password && (
                                <p className="mt-1 text-xs text-red-500">{errors.password}</p>
                            )}
                        </div>

                    {/* Forgot Password Link */}
                    <div className="flex justify-end items-center mt-1">
                        <button
                            type="button"
                            onClick={handleForgotPassword}
                            className="text-sm text-blue-600 hover:text-blue-700 hover:underline transition-colors font-medium"
                        >
                            Forgot Password?
                        </button>
                    </div>

                        {/* Submit Button */}
                        <motion.button
                            type="submit"
                            disabled={isLoading}
                            whileHover={{ scale: isLoading ? 1 : 1.02 }}
                            whileTap={{ scale: isLoading ? 1 : 0.98 }}
                            className={`w-full py-3 rounded-xl font-semibold text-white transition-all flex items-center justify-center gap-2 mt-4 ${isLoading
                                ? 'bg-blue-400 cursor-not-allowed'
                                : 'bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 shadow-lg'
                                }`}
                        >
                            {isLoading ? (
                                <>
                                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                                    Signing In...
                                </>
                            ) : (
                                'Sign In'
                            )}
                        </motion.button>
                    </form>

                    {/* Divider */}
                    <div className="relative mt-4">
                        <div className="absolute inset-0 flex items-center">
                            <div className="w-full border-t border-gray-300"></div>
                        </div>
                        <div className="relative flex justify-center text-sm">
                            <span className="px-2 bg-white/80 text-gray-500">Or</span>
                        </div>
                    </div>

                    {/* Signup Link */}
                    <motion.button
                        whileHover={{ scale: 1.02 }}
                        whileTap={{ scale: 0.98 }}
                        type="button"
                        onClick={() => navigate("/signup")}
                        className="w-full py-3 mt-4 rounded-xl border-2 border-blue-200 text-blue-600 font-semibold text-sm transition-all hover:bg-blue-50 flex items-center justify-center gap-2"
                    >
                        <UserPlus className="w-4 h-4" />
                        Don't have an account? Sign Up
                    </motion.button>
                </div>
            </motion.div>

            {/* Success Popup */}
            <AnimatePresence>
                {showSuccessPopup && userData && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
                    >
                        <motion.div
                            initial={{ scale: 0.8, opacity: 0, y: 50 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.8, opacity: 0, y: 50 }}
                            transition={{ type: "spring", damping: 25, stiffness: 300 }}
                            className="bg-white rounded-2xl shadow-2xl max-w-md w-full overflow-hidden"
                            onClick={(e) => e.stopPropagation()}
                        >
                            <div className="relative bg-gradient-to-r from-blue-600 to-indigo-600 p-6 text-white text-center">
                                <motion.div
                                    initial={{ scale: 0 }}
                                    animate={{ scale: 1 }}
                                    transition={{ delay: 0.2, type: "spring", stiffness: 200 }}
                                    className="absolute -top-8 left-1/2 transform -translate-x-1/2"
                                >
                                    <div className="bg-white rounded-full p-3 shadow-lg">
                                        <CheckCircle className="w-12 h-12 text-blue-600" />
                                    </div>
                                </motion.div>
                                <button
                                    onClick={handleClosePopup}
                                    className="absolute top-4 right-4 text-white/80 hover:text-white transition-colors"
                                >
                                    <X className="w-5 h-5" />
                                </button>
                                <div className="mt-6">
                                    <motion.h2
                                        initial={{ y: 20, opacity: 0 }}
                                        animate={{ y: 0, opacity: 1 }}
                                        transition={{ delay: 0.3 }}
                                        className="text-2xl font-bold mb-2"
                                    >
                                        Welcome Back!
                                    </motion.h2>
                                    <motion.p
                                        initial={{ y: 20, opacity: 0 }}
                                        animate={{ y: 0, opacity: 1 }}
                                        transition={{ delay: 0.4 }}
                                        className="text-blue-100"
                                    >
                                        You have successfully logged in
                                    </motion.p>
                                </div>
                            </div>

                            <div className="p-6">
                                <motion.div
                                    initial={{ y: 20, opacity: 0 }}
                                    animate={{ y: 0, opacity: 1 }}
                                    transition={{ delay: 0.5 }}
                                    className="text-center mb-6"
                                >
                                    <div className="flex justify-center mb-4">
                                        <motion.div
                                            animate={{
                                                rotate: [0, 10, -10, 10, 0],
                                                scale: [1, 1.1, 1]
                                            }}
                                            transition={{ delay: 0.6, duration: 0.5 }}
                                        >
                                            <Rocket className="w-16 h-16 text-blue-600" />
                                        </motion.div>
                                    </div>

                                    <p className="text-gray-600 mb-4">
                                        Hello <span className="font-semibold text-blue-600">{userData.name}</span>!
                                        You are now logged in as a <span className="font-semibold capitalize">{userData.role}</span>.
                                    </p>

                                    <div className="bg-blue-50 rounded-lg p-4 mb-6">
                                        <div className="flex items-center gap-2 text-blue-700 mb-3">
                                            <Sparkles className="w-4 h-4" />
                                            <span className="font-semibold">Session Details</span>
                                        </div>
                                        <div className="text-sm text-gray-600 space-y-1 text-left">
                                            <p>📧 <span className="font-medium">Email:</span> {userData.email}</p>
                                            <p>👤 <span className="font-medium">Role:</span> {userData.role === "admin" ? "Placement Admin" : "Student"}</p>
                                            <p>🕐 <span className="font-medium">Login Time:</span> {userData.loginTime}</p>
                                            <p>📅 <span className="font-medium">Date:</span> {userData.loginDate}</p>
                                        </div>
                                    </div>

                                    <div className="bg-gray-50 rounded-lg p-3 mb-4">
                                        <p className="text-xs text-gray-500">
                                            {userData.role === "student"
                                                ? "🎓 Access placement drives, view company listings, and track your applications"
                                                : "📊 Manage placement records, schedule company drives, and view student analytics"}
                                        </p>
                                    </div>
                                </motion.div>

                                <motion.div
                                    initial={{ y: 20, opacity: 0 }}
                                    animate={{ y: 0, opacity: 1 }}
                                    transition={{ delay: 0.6 }}
                                >
                                    <motion.button
                                        whileHover={{ scale: 1.02 }}
                                        whileTap={{ scale: 0.98 }}
                                        onClick={handleGoToDashboard}
                                        className="w-full py-3 bg-gradient-to-r from-blue-600 to-indigo-600 text-white rounded-xl font-semibold hover:from-blue-700 hover:to-indigo-700 transition-all shadow-md flex items-center justify-center gap-2"
                                    >
                                        <Trophy className="w-5 h-5" />
                                        Go to Dashboard
                                    </motion.button>
                                </motion.div>

                                <p className="text-center text-xs text-gray-400 mt-4">
                                    Redirecting to dashboard in 2 seconds...
                                </p>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

export default Login;